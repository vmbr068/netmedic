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


class Settings(BaseModel):
    api_key: str = ""
    api_base: str = "https://api.meta.ai/v1"
    model: str = "muse-spark-1.3"
    reasoning_effort: str | None = None
    inventory_path: Path = Path("inventory.yaml")
    runbooks_dir: Path = Path("runbooks")

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
            model=model.get("name", cls.model_fields["model"].default),
            reasoning_effort=model.get("reasoning_effort"),
            inventory_path=Path(raw.get("inventory", "inventory.yaml")),
            runbooks_dir=Path(raw.get("runbooks", "runbooks")),
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


class Inventory(BaseModel):
    ssh: SSHConfig = Field(default_factory=SSHConfig)
    routers: dict[str, Router]

    @classmethod
    def load(cls, path: Path) -> Inventory:
        raw = yaml.safe_load(path.read_text())
        routers = {name: Router(name=name, **spec) for name, spec in raw["routers"].items()}
        return cls(ssh=SSHConfig(**raw.get("ssh", {})), routers=routers)
