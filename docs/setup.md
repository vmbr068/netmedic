# Setup

## Requirements

- Linux with Nix (flakes enabled) — the dev shell provides Python 3.12, uv, sops, OpenSSH, Node 22.
- KVM for the lab VMs (8 VMs × ~450 MB RAM for the enterprise topology).
- A Meta Model API key (Muse Spark, SAM 3.1).

## Install

```sh
git clone https://github.com/vmbr068/netmedic && cd netmedic
nix develop
uv sync
(cd frontend && npm ci && npm run build)   # optional: the built UI is committed in src/netmedic/web
```

## API key

Either export it:

```sh
export META_API_KEY=...
```

or keep it encrypted in `secrets.yaml` with [sops](https://github.com/getsops/sops)
(`meta.api_key`, plus `server.token` for `--lan`). `META_API_KEY` in the environment wins over sops.

## Run against the lab

```sh
lab/lab.sh use enterprise
lab/lab.sh up                       # first run builds the VMs, then ~1 min to boot
uv run netmedic status              # BIRD protocols on every router
uv run netmedic watch               # http://127.0.0.1:8080
lab/chaos.sh failover-broken        # in another terminal
```

## Commands

| Command | |
|---|---|
| `netmedic watch [--mode auto\|approval] [--lan] [--ui-only]` | monitor, investigate, fix; serve the UI and the API |
| `netmedic diagnose "<incident>"` | investigate only, print the diagnosis (read-only) |
| `netmedic fix "<incident>" [--mode auto]` | investigate, then apply the plan safely |
| `netmedic eval [--runs N] [--scenario S]` | replay chaos scenarios and measure (see [evaluation](evaluation.md)) |
| `netmedic status` | protocol state on every router |

`--lan` serves HTTPS on every LAN address with a generated CA and an access token, and prints a
QR code for the phone (see [Rack Vision](rack-vision.md#phone-setup)). `--ui-only` serves the UI and
Rack Vision without monitoring or changing anything.

## Configuration — `netmedic.yaml`

| Key | Default | |
|---|---|---|
| `model.tiers` | Spark low → Spark high → Wonder | model ladder, one tier per attempt |
| `model.timeout`, `model.max_retries` | 45 s, 3 | per model call |
| `incident_timeout` | 420 s | max investigation time, then escalate |
| `watch.interval` | 5 s | probe period |
| `watch.confirm_polls` | 2 | probes a symptom must persist |
| `watch.mode` | auto | `auto` applies low-risk steps alone, `approval` asks for everything |
| `watch.max_attempts` | 3 | per set of symptoms, then escalate |
| `watch.settle` | 20 s | reconvergence time after an incident |

`inventory.yaml` lists the managed routers (SSH host/port, ASN, loopback, role) and the
reachability targets; `lab/lab.sh use` generates it for the lab. `cabling.yaml` (optional) gives
Rack Vision the expected cabling: `{cabling: [{device: sw1, port: 12, router: edge1, interface: to-core1}]}`.

## HTTP API

| Endpoint | |
|---|---|
| `GET /api/events` | server-sent events: state snapshots and the live incident (replayed on connect) |
| `GET /api/status` | current snapshot and pending approvals |
| `POST /api/alerts` | Alertmanager webhook or `{"summary": "..."}` → incident |
| `POST /api/approvals/{id}` | `{"approve": true\|false}` |
| `POST /api/mode` | `{"mode": "auto"\|"approval"}` |
| `GET /api/reports`, `GET /api/reports/{name}` | incident reports |
| `POST /api/vision/ports`, `/scan[?for_request=id]`, `/trace?x=&y=` | Rack Vision (image body) |
