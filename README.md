# netmedic

> Autonomous AI agent that detects, diagnoses and remediates network incidents — safely.

Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026). Everything in this
repository was written during the hackathon. Powered by **Muse Spark** (Meta Model API).

## Quick start

```sh
nix develop          # python 3.12 + uv
uv sync
sops secrets.yaml                          # meta.api_key (GPG-encrypted, see .sops.yaml)
cp inventory.example.yaml inventory.yaml   # set router IPs
uv run netmedic status
uv run netmedic diagnose "BGP session between r1 and r2 is down"
```

See [PLAN.md](PLAN.md) for the architecture and roadmap.
