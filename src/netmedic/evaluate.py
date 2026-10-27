"""Eval harness: replay chaos scenarios through the real watcher and measure how netmedic does.

Each run: reset the lab -> wait until healthy -> start a fresh watcher (auto mode) -> inject the
scenario -> wait until the network is healthy again (success) or the time budget runs out.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from .config import Inventory, Settings
from .events import Event
from .models import Remediation
from .ssh import RouterPool
from .watcher import Watcher

CHAOS = Path("lab/chaos.sh")


def default_scenarios() -> list[str]:
    """Scenarios of the current lab topology (lab/chaos.sh list)."""
    import subprocess

    out = subprocess.run([str(CHAOS), "list"], capture_output=True, text=True).stdout
    return [line.split()[0] for line in out.splitlines() if line.startswith("  ")]


@dataclass
class RunResult:
    scenario: str
    run: int
    success: bool = False
    detect_s: float | None = None
    resolve_s: float | None = None
    incidents: int = 0
    statuses: list[str] = field(default_factory=list)
    llm_calls: int = 0
    tool_calls: int = 0
    prompt_tokens: int = 0
    cached_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    models: list[str] = field(default_factory=list)
    escalations: int = 0
    rollbacks: int = 0
    error: str = ""


async def _chaos(*args: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        str(CHAOS), *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    await proc.wait()


async def _wait_healthy(watcher: Watcher, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        symptoms, tables = await watcher.probe()
        if not symptoms and all(tables.values()):
            return True
        await asyncio.sleep(3)
    return False


async def run_one(settings: Settings, inventory: Inventory, pool: RouterPool, scenario: str, run: int,
                  budget: float) -> RunResult:
    result = RunResult(scenario, run)
    cfg = settings.model_copy(deep=True)
    cfg.watch.mode = "auto"

    async def approve(_: Remediation) -> bool:  # medium/high-risk steps are approved in evals
        return True

    async def sink(event: Event) -> None:
        d = event.data
        if event.kind == "incident_opened":
            result.incidents += 1
            if result.detect_s is None:
                result.detect_s = round(event.ts - t0, 1)
        elif event.kind == "incident_closed":
            result.statuses.append(d.get("status", "?"))
        elif event.kind == "usage":
            for k in ("llm_calls", "tool_calls", "prompt_tokens", "cached_tokens", "completion_tokens"):
                setattr(result, k, getattr(result, k) + d.get(k, 0))
            result.cost_usd += d.get("cost_usd") or 0.0
            result.models.append(d.get("model", "?"))
        elif event.kind == "escalate":
            result.escalations += 1
        elif event.kind == "rollback":
            result.rollbacks += 1

    probe_only = Watcher(cfg, inventory, pool, approve)
    await _chaos("reset")
    if not await _wait_healthy(probe_only, 120):
        result.error = "lab not healthy before the run"
        return result

    watcher = Watcher(cfg, inventory, pool, approve, on_event=sink)
    task = asyncio.create_task(watcher.run())
    t0 = time.time()
    try:
        for _ in range(60):  # baseline is learned on the first healthy probe
            if watcher.baseline is not None:
                break
            await asyncio.sleep(0.5)
        t0 = time.time()
        await _chaos(scenario)
        while time.time() - t0 < budget:
            await asyncio.sleep(1)
            healthy_now = not watcher.symptoms and not watcher.busy
            if result.incidents and healthy_now and result.statuses:
                result.success = True
                result.resolve_s = round(time.time() - t0, 1)
                break
        else:
            result.error = f"not healthy after {budget:.0f}s"
    finally:
        task.cancel()
        if watcher._task is not None:
            watcher._task.cancel()
        await asyncio.gather(task, *( [watcher._task] if watcher._task else []), return_exceptions=True)
    return result


def summarize(results: list[RunResult]) -> list[dict]:
    rows = []
    for scenario in dict.fromkeys(r.scenario for r in results):
        rs = [r for r in results if r.scenario == scenario]
        ok = [r for r in rs if r.success]
        med = lambda xs: round(statistics.median(xs), 1) if xs else None  # noqa: E731
        rows.append({
            "scenario": scenario,
            "runs": len(rs),
            "success": len(ok),
            "success_rate": round(len(ok) / len(rs), 2),
            "median_detect_s": med([r.detect_s for r in rs if r.detect_s is not None]),
            "median_resolve_s": med([r.resolve_s for r in ok]),
            "avg_incidents": round(sum(r.incidents for r in rs) / len(rs), 1),
            "avg_tool_calls": round(sum(r.tool_calls for r in rs) / len(rs), 1),
            "avg_tokens": round(sum(r.prompt_tokens + r.completion_tokens for r in rs) / len(rs)),
            "cache_hit": round(sum(r.cached_tokens for r in rs) / max(1, sum(r.prompt_tokens for r in rs)), 2),
            "avg_cost_usd": round(sum(r.cost_usd for r in rs) / len(rs), 4),
            "rollbacks": sum(r.rollbacks for r in rs),
            "escalations": sum(r.escalations for r in rs),
        })
    return rows


def render_markdown(rows: list[dict], results: list[RunResult], model: str) -> str:
    total = sum(r["runs"] for r in rows)
    ok = sum(r["success"] for r in rows)
    lines = [
        f"# netmedic eval — {datetime.now():%Y-%m-%d %H:%M}",
        "",
        f"Model: `{model}` · {ok}/{total} runs resolved ({ok / total:.0%})" if total else "No runs.",
        "",
        "| Scenario | Success | Median detect | Median resolve | Incidents | Tool calls | Tokens | Cache hit | Cost/run | Rollbacks |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['scenario']} | {r['success']}/{r['runs']} | {r['median_detect_s']}s | "
            f"{r['median_resolve_s']}s | {r['avg_incidents']} | {r['avg_tool_calls']} | "
            f"{r['avg_tokens']} | {r['cache_hit']:.0%} | ${r['avg_cost_usd']:.4f} | {r['rollbacks']} |"
        )
    failures = [r for r in results if not r.success]
    if failures:
        lines += ["", "## Failures"]
        lines += [f"- {r.scenario} #{r.run}: {r.error or ', '.join(r.statuses)}" for r in failures]
    return "\n".join(lines) + "\n"


def save(results: list[RunResult], rows: list[dict], markdown: str, directory: Path = Path("reports")) -> Path:
    directory.mkdir(exist_ok=True)
    stem = directory / f"eval-{datetime.now():%Y%m%d-%H%M%S}"
    stem.with_suffix(".json").write_text(json.dumps(
        {"summary": rows, "runs": [asdict(r) for r in results]}, indent=2))
    stem.with_suffix(".md").write_text(markdown)
    return stem.with_suffix(".md")
