"""Structured outputs produced by the agent."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Hypothesis(BaseModel):
    cause: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[str]


class Remediation(BaseModel):
    title: str
    router: str
    description: str
    risk: Literal["low", "medium", "high"]
    impact: str
    rollback: str


class Diagnosis(BaseModel):
    summary: str
    affected: list[str]
    root_cause: str
    hypotheses: list[Hypothesis]
    remediations: list[Remediation]


DIAGNOSIS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_diagnosis",
        "description": "Call exactly once when the investigation is complete, to submit the final "
        "diagnosis. Hypotheses ranked by confidence, remediations ranked by preference.",
        "parameters": Diagnosis.model_json_schema(),
    },
}
