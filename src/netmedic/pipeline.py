"""Incident pipeline shared by the CLI, the watcher and the webhook: investigate -> decide -> fix -> report."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .agent import Agent
from .config import Inventory, Settings
from .events import Event, EventSink, noop_sink
from .models import Diagnosis, Remediation
from .remediate import Executor, Outcome
from .report import render_report, save_report
from .runbooks import load_runbooks
from .ssh import RouterPool
from .tools import Toolbox

Approver = Callable[[Remediation], Awaitable[bool]]


@dataclass
class Step:
    remediation: Remediation
    outcome: Outcome | None  # None: not applied (declined)


@dataclass
class IncidentResult:
    diagnosis: Diagnosis
    steps: list[Step] = field(default_factory=list)
    report: Path | None = None

    @property
    def status(self) -> str:
        escalated = bool(self.diagnosis.escalation.strip())
        if not self.diagnosis.plan:
            return "ESCALATED" if escalated else "NO ACTION NEEDED"
        ok = [s.outcome is not None and s.outcome.success for s in self.steps]
        if all(ok):
            return "RESOLVED + ESCALATED" if escalated else "RESOLVED"
        return "PARTIALLY RESOLVED" if any(ok) else "NOT RESOLVED"

    @property
    def escalated(self) -> bool:
        return bool(self.diagnosis.escalation.strip())

    @property
    def resolved(self) -> bool:
        return self.status in ("RESOLVED", "RESOLVED + ESCALATED", "NO ACTION NEEDED", "ESCALATED")


async def handle_incident(
    incident: str,
    settings: Settings,
    inventory: Inventory,
    pool: RouterPool,
    mode: str,
    approve: Approver,
    on_event: EventSink = noop_sink,
    tier: int = 0,
) -> IncidentResult:
    """Apply every step of the plan in order, each verified (and rolled back) on its own.
    mode 'auto' applies low-risk steps on its own and asks `approve` for the rest;
    mode 'approval' always asks."""
    started = datetime.now()
    agent = Agent(settings, inventory, Toolbox(pool), load_runbooks(settings.runbooks_dir), on_event=on_event, tier=tier)
    try:
        diagnosis = await asyncio.wait_for(agent.investigate(incident), settings.incident_timeout)
    except Exception as e:
        reason = "timed out" if isinstance(e, asyncio.TimeoutError) else f"failed: {type(e).__name__}: {e}"
        await on_event(Event("escalate", {"text": f"investigation {reason} — escalating to a human"}))
        raise
    result = IncidentResult(diagnosis)
    executor = Executor(pool, on_event=on_event)

    total = len(result.diagnosis.plan)
    for i, rem in enumerate(result.diagnosis.plan, 1):
        label = f"step {i}/{total} '{rem.title}'"
        if mode == "auto" and rem.risk == "low":
            await on_event(Event("decision", {"text": f"auto mode: applying low-risk {label}"}))
        elif await approve(rem):
            await on_event(Event("decision", {"text": f"approved: applying {label}"}))
        else:
            await on_event(Event("decision", {"text": f"not applied: {label}"}))
            result.steps.append(Step(rem, None))
            continue
        result.steps.append(Step(rem, await executor.execute(rem)))

    result.report = save_report(render_report(incident, result, mode, started), started)
    if result.escalated:
        await on_event(Event("escalate", {"text": f"escalated to a human: {result.diagnosis.escalation}"}))
    await on_event(Event("incident_closed", {
        "text": f"incident {result.status} — report {result.report}",
        "status": result.status, "resolved": result.resolved, "escalated": result.escalated,
        "report": str(result.report),
    }))
    return result
