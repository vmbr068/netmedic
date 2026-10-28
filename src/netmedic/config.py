"""Settings (netmedic.yaml + sops-encrypted secrets.yaml) and router inventory (YAML)."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

CONFIG_PATH = Path(os.environ.get("NETMEDIC_CONFIG", "netmedic.yaml"))
SECRETS_PATH = Path(os.environ.get("NETMEDIC_SECRETS", "secrets.yaml"))


def load_secrets(path: Path = SECRETS_PATH) -> dict:
    """Decrypt secrets.yaml with sops (needs the GPG card plugged in)."""
    if not path.exists():
        return {}
    try:
        out = subprocess.run(
            ["sops", "--decrypt", "--output-type", "json", str(path)],
            check=True, capture_output=True, text=True,
        ).stdout
    except FileNotFoundError as e:
        raise SystemExit("sops is not installed (run inside `nix develop`)") from e
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"failed to decrypt {path}:\n{e.stderr.strip()}") from e
    return json.loads(out)


class WatchConfig(BaseModel):
    interval: float = 5.0
    confirm_polls: int = 2
    mode: str = "auto"
    max_attempts: int = 2
    settle: float = 20.0
    dns_names: list[str] = []


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8080


class ModelTier(BaseModel):
    name: str
    reasoning_effort: str | None = None

    @property
    def label(self) -> str:
        return f"{self.name}" + (f" (effort {self.reasoning_effort})" if self.reasoning_effort else "")


DEFAULT_TIERS = [ModelTier(name="muse-spark-1.3", reasoning_effort="low")]


class Settings(BaseModel):
    api_key: str = ""
    api_base: str = "https://api.meta.ai/v1"
    # Escalation ladder: the first attempt on an incident uses tiers[0]; each failed attempt
    # moves one tier up (more reasoning, then a bigger model).
    tiers: list[ModelTier] = Field(default_factory=lambda: list(DEFAULT_TIERS))
    # USD per 1M tokens: [input, cached input, output]
    prices: dict[str, list[float]] = {}
    api_max_retries: int = 3
    api_timeout: float = 45.0
    incident_timeout: float = 420.0
    inventory_path: Path = Path("inventory.yaml")
    runbooks_dir: Path = Path("runbooks")
    watch: WatchConfig = Field(default_factory=WatchConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)

    @property
    def model(self) -> str:
        return self.tiers[0].name

    def tier(self, index: int) -> ModelTier:
        return self.tiers[max(0, min(index, len(self.tiers) - 1))]

    def cost(self, model: str, prompt: int, cached: int, completion: int) -> float | None:
        price = self.prices.get(model)
        if not price:
            return None
        return ((prompt - cached) * price[0] + cached * price[1] + completion * price[2]) / 1e6

    @classmethod
    def load(cls, with_secrets: bool = True) -> Settings:
        """Read netmedic.yaml, then secrets.yaml. META_API_KEY in the environment wins over sops."""
        raw = yaml.safe_load(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
        model = raw.get("model", {})
        api_key = os.environ.get("META_API_KEY", "")
        if with_secrets and not api_key:
            api_key = load_secrets().get("meta", {}).get("api_key", "")
        return cls(
            api_key=api_key,
            api_base=model.get("api_base", cls.model_fields["api_base"].default),
            tiers=[ModelTier(**t) for t in model.get("tiers", [])] or list(DEFAULT_TIERS),
            prices=model.get("prices", {}),
            api_max_retries=model.get("max_retries", 3),
            api_timeout=model.get("timeout", 45.0),
            incident_timeout=raw.get("incident_timeout", 420.0),
            inventory_path=Path(os.environ.get("NETMEDIC_INVENTORY") or raw.get("inventory", "inventory.yaml")),
            runbooks_dir=Path(raw.get("runbooks", "runbooks")),
            watch=WatchConfig(**(raw.get("watch") or {})),
            server=ServerConfig(**(raw.get("server") or {})),
        )


class SSHConfig(BaseModel):
    user: str = "root"
    key: str | None = None
    port: int = 22


class Router(BaseModel):
    name: str
    host: str
    asn: int | None = None
    port: int | None = None
    loopback: str | None = None
    role: str | None = None
    layer: int | None = None


class Inventory(BaseModel):
    ssh: SSHConfig = Field(default_factory=SSHConfig)
    routers: dict[str, Router]
    notes: str = ""  # network design notes, given to the agent
    targets: list[str] = []  # addresses every router must reach (e.g. the internet)

    @classmethod
    def load(cls, path: Path) -> Inventory:
        raw = yaml.safe_load(path.read_text())
        routers = {name: Router(name=name, **spec) for name, spec in raw["routers"].items()}
        return cls(ssh=SSHConfig(**raw.get("ssh", {})), routers=routers,
                   notes=raw.get("notes", ""), targets=raw.get("targets") or [])
