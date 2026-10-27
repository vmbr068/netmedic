"""Structured outputs produced by the agent: diagnosis, typed remediation actions and checks."""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, model_validator

# --- Remediation actions: the only ways the agent can change a router -----------------------


class EditBirdConfig(BaseModel):
    """Replace one exact snippet in an agent-managed BIRD file (/var/lib/netagent/<file>)."""

    type: Literal["edit_bird_config"] = "edit_bird_config"
    router: str
    file: str = Field("bgp.conf", description="File name inside /var/lib/netagent/")
    find: str = Field(description="Exact text to replace; must occur exactly once in the file")
    replace: str

    @model_validator(mode="after")
    def _not_a_noop(self) -> EditBirdConfig:
        if self.find == self.replace:
            raise ValueError("edit_bird_config with find == replace changes nothing; if no fix is "
                             "needed, submit an empty plan")
        return self


class SetInterface(BaseModel):
    """Set an interface administratively up/down and optionally its MTU."""

    type: Literal["set_interface"] = "set_interface"
    router: str
    interface: str
    state: Literal["up", "down"] = "up"
    mtu: int | None = None


class DeleteNftRule(BaseModel):
    """Delete one nftables rule by handle (see firewall_rules output, '# handle N')."""

    type: Literal["delete_nft_rule"] = "delete_nft_rule"
    router: str
    family: str = "inet"
    table: str
    chain: str
    handle: int


class DeleteNftTable(BaseModel):
    """Delete a whole non-system nftables table."""

    type: Literal["delete_nft_table"] = "delete_nft_table"
    router: str
    family: str = "inet"
    table: str


class RestartService(BaseModel):
    """Restart an allow-listed systemd service (bird, unbound, systemd-networkd)."""

    type: Literal["restart_service"] = "restart_service"
    router: str
    service: Literal["bird", "unbound", "systemd-networkd"]


Action = Annotated[
    Union[EditBirdConfig, SetInterface, DeleteNftRule, DeleteNftTable, RestartService],
    Field(discriminator="type"),
]

# --- Verification checks: executed by netmedic, not by the model ------------------------------


class BgpEstablished(BaseModel):
    type: Literal["bgp_established"] = "bgp_established"
    router: str
    protocol: str


class RoutePresent(BaseModel):
    type: Literal["route_present"] = "route_present"
    router: str
    prefix: str
    protocol: str | None = Field(None, description="Expected source protocol of the best route")


class PingOk(BaseModel):
    type: Literal["ping_ok"] = "ping_ok"
    router: str
    target: str


class DnsResolves(BaseModel):
    type: Literal["dns_resolves"] = "dns_resolves"
    router: str
    name: str


Check = Annotated[Union[BgpEstablished, RoutePresent, PingOk, DnsResolves], Field(discriminator="type")]

# --- Diagnosis --------------------------------------------------------------------------------


class Hypothesis(BaseModel):
    cause: str
    confidence: float = Field(ge=0, le=1)
    evidence: list[str]


class Remediation(BaseModel):
    title: str
    root_cause: str = Field(description="Which root cause this fixes")
    description: str
    risk: Literal["low", "medium", "high"]
    impact: str
    actions: list[Action] = Field(min_length=1, description="Applied in order")
    checks: list[Check] = Field(min_length=1, description="All must pass for the fix to be kept")


class Diagnosis(BaseModel):
    summary: str
    affected: list[str]
    root_cause: str
    hypotheses: list[Hypothesis]
    plan: list[Remediation] = Field(
        description="Fixes to apply, one per independent root cause, ordered so that a fix never "
        "depends on a later one. Empty if nothing needs to change."
    )
    alternatives: list[Remediation] = Field(
        default_factory=list, description="Other options considered, not applied"
    )


DIAGNOSIS_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_diagnosis",
        "description": "Call exactly once when the investigation is complete, to submit the final "
        "diagnosis. Hypotheses ranked by confidence; a plan with one fix per independent root cause "
        "(typed actions + the checks that prove that fix worked); alternatives not applied.",
        "parameters": Diagnosis.model_json_schema(),
    },
}
