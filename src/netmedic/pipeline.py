"""Incident pipeline shared by the CLI, the watcher and the webhook: investigate -> decide -> fix -> report."""

from __future__ import annotations

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
        if not self.diagnosis.plan:
            return "NO ACTION NEEDED"
        ok = [s.outcome is not None and s.outcome.success for s in self.steps]
        if all(ok):
            return "RESOLVED"
        return "PARTIALLY RESOLVED" if any(ok) else "NOT RESOLVED"

    @property
    def resolved(self) -> bool:
        return self.status in ("RESOLVED", "NO ACTION NEEDED")


async def handle_incident(
    incident: str,
    settings: Settings,
    inventory: Inventory,
    pool: RouterPool,
    mode: str,
    approve: Approver,
    on_event: EventSink = noop_sink,
) -> IncidentResult:
    """Apply every step of the plan in order, each verified (and rolled back) on its own.
    mode 'auto' applies low-risk steps on its own and asks `approve` for the rest;
    mode 'approval' always asks."""
    started = datetime.now()
    agent = Agent(settings, inventory, Toolbox(pool), load_runbooks(settings.runbooks_dir), on_event=on_event)
    result = IncidentResult(await agent.investigate(incident))
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
    await on_event(Event("incident_closed", {
        "text": f"incident {result.status} — report {result.report}",
        "status": result.status, "resolved": result.resolved, "report": str(result.report),
    }))
    return result
