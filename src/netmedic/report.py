"""Incident report (RCA) in Markdown."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .pipeline import IncidentResult


def render_report(incident: str, result: IncidentResult, mode: str, started: datetime) -> str:
    dx = result.diagnosis
    lines = [
        f"# Incident report — {started:%Y-%m-%d %H:%M:%S}",
        "",
        f"**Status:** {result.status}  ",
        f"**Duration:** {(datetime.now() - started).total_seconds():.1f}s  ",
        f"**Mode:** {mode}  ",
        "",
        "## Alert",
        incident,
        "",
        "## Summary",
        dx.summary,
        "",
        "## Root cause",
        dx.root_cause,
        "",
        f"**Affected:** {', '.join(dx.affected)}",
        "",
        "## Evidence",
    ]
    for h in dx.hypotheses:
        lines.append(f"- **{h.confidence:.0%} — {h.cause}**")
        lines += [f"  - `{e}`" for e in h.evidence]

    if dx.escalation.strip():
        lines += ["", "## Escalation", dx.escalation]
    lines += ["", "## Remediation plan"]
    if not result.steps:
        lines.append("No change needed.")
    for i, step in enumerate(result.steps, 1):
        rem, out = step.remediation, step.outcome
        verdict = "not applied" if out is None else ("kept" if out.success else "rolled back")
        lines += [
            "",
            f"### Step {i}: {rem.title} — {verdict}",
            f"*Root cause addressed:* {rem.root_cause}  ",
            f"*Risk:* {rem.risk}",
            "",
            rem.description,
            "",
            "Actions:",
        ]
        lines += [f"- `{a.model_dump_json()}`" for a in rem.actions]
        if out is not None:
            lines += ["", f"Execution log ({out.duration:.1f}s):"]
            lines += [f"- {entry}" for entry in out.log]

    lines += ["", "## Alternatives considered"]
    lines += [f"- {r.title} (risk: {r.risk})" for r in dx.alternatives] or ["- none"]
    return "\n".join(lines) + "\n"


def save_report(text: str, started: datetime, directory: Path = Path("reports")) -> Path:
    directory.mkdir(exist_ok=True)
    path = directory / f"{started:%Y%m%d-%H%M%S}-incident.md"
    path.write_text(text)
    return path
