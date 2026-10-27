"""Runbooks: YAML diagnostic paths that guide the agent's investigation."""

from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel


class Runbook(BaseModel):
    id: str
    title: str
    triggers: list[str]
    steps: list[str]
    known_causes: list[str] = []

    def render(self) -> str:
        steps = "\n".join(f"  {i}. {s}" for i, s in enumerate(self.steps, 1))
        causes = "\n".join(f"  - {c}" for c in self.known_causes)
        return f"### {self.title} [{self.id}]\nWhen: {'; '.join(self.triggers)}\nSteps:\n{steps}\n" + (
            f"Known causes:\n{causes}\n" if causes else ""
        )


def load_runbooks(directory: Path) -> list[Runbook]:
    if not directory.is_dir():
        return []
    return [Runbook(**yaml.safe_load(p.read_text())) for p in sorted(directory.glob("*.yaml"))]
