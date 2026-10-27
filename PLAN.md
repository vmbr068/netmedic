# netmedic — Project Plan

> Autonomous AI agent that detects, diagnoses and remediates network incidents — safely.
> Meta Global AI Developer Hackathon (Cerebral Valley) — Oct 27 – Nov 4, 2026

## Project

- **Name:** netmedic (repo: `meta-hackathon`, must be **public at submission**)
- **Concept:** an AI agent that automatically **detects, diagnoses and fixes network failures** (BGP, interfaces, routing, services…), following runbooks, proposing ranked remediation options, applying them safely, and producing an incident report with multi-channel alerting.
- **Problem statement:** "Build for Your World"
- **Track:** Indie Developer (solo, may team up later — max 4)
- **Availability:** Tue Oct 27 → Fri Oct 30 (daytime), **off Fri evening → Sun evening**, back Mon Nov 2 → Wed Nov 4
- **Target:** working end-to-end MVP by **Fri Oct 30**, extras + video Mon/Tue, **submit Wed Nov 4 before noon** (official deadline: **Wed Nov 4, 9:00 PM ET**)

## Tech Stack

| Area | Choice |
|---|---|
| Language | **Python** (`uv` + `pyproject.toml`) |
| AI model | **Muse Spark** via Meta Model API — swappable backend |
| Open weights (optional) | Muse Spark Open / Muse Glimmer on DGX Spark or Baseten (`meta-models/muse-spark-open-1026`) → $10K open-weight bonus |
| Dev tooling | Claude Code (Muse Code is not mandatory) |
| Router access | `asyncssh` |
| Data models | `pydantic` |
| Runbooks | **YAML** (diagnostic & remediation paths) |
| Web UI | **FastAPI + SSE + htmx** (live view of agent reasoning & tool calls) |
| Notifications | **Web, Telegram, Discord** first (with Approve button), then Slack (webhook) & Mail (`aiosmtplib`) if time allows |
| Incident report (RCA) | Jinja2 → Markdown / HTML |

## Demo Lab

- **Proxmox** host, **4 NixOS routers** running **BIRD 2**
- Routers declared in a **Nix flake**, deployed with `nixos-rebuild --target-host` or `colmena`
- Nix-generated BIRD config is read-only (`/nix/store`) → it does `include "/var/lib/netagent/*.conf"`: the **only area the agent is allowed to modify**
- **Chaos script** injecting 3 varied scenarios (to show it's not BGP-only):
  1. BGP: wrong peer AS / prefix filter blocking routes
  2. Interface down / MTU mismatch
  3. DNS not responding / missing route

## Agent Pipeline

```
Alert → Diagnosis (tools + runbooks) → Ranked hypotheses (with evidence)
→ Remediation options (risk / impact / rollback)
→ Policy: auto OR approval request
→ birdc configure check → birdc configure timeout
→ Post-change verification → configure confirm | automatic rollback
→ Incident report (RCA) + notifications
```

- **Modes:** `auto` or `approval`, configurable (per risk level / action type)
- **Safety ("verifiable agent"):**
  - `birdc configure check` — syntax validation before apply
  - `birdc configure timeout N` — BIRD auto-reverts unless `configure confirm` is sent
  - NixOS generations as an extra safety net (`nixos-rebuild test` / rollback)
  - Agent write scope restricted to `/var/lib/netagent/`
  - Note: Batfish does not support BIRD → verification via `configure check`, reachability tests, protocol state

## Architecture

```
┌──────── Proxmox lab: 4 NixOS routers + BIRD 2 ────────┐
│  chaos script: injects failures                       │
└──────────────▲────────────────────────────────────────┘
               │ SSH (birdc, ip, ping, traceroute, journalctl)
┌──────────────┴──────────── netmedic (Python) ─────────────────────┐
│ Detection   : birdc polling / probes (+ Alertmanager webhook)     │
│ Agent       : Muse Spark tool-calling loop, guided by runbooks    │
│ Policy      : risk × mode (auto / approval)                       │
│ Safe apply  : check → timeout → verify → confirm | rollback       │
│ Report      : RCA Markdown/HTML + full action timeline            │
│ Notifiers   : common interface → Web, Telegram, Discord, Slack, Mail │
│ Web UI      : FastAPI + SSE, live agent reasoning                 │
└───────────────────────────────────────────────────────────────────┘
       Model: Muse Spark (API) ⇄ Muse Spark Open / Glimmer (DGX Spark / Baseten)
```

## Phase 2 Extras (Mon Nov 2, after MVP)

- **Rack Vision (headline feature, see below)**
- Open weights backend: Muse Spark Open / Glimmer on DGX Spark or Baseten → "configs never leave your infra" + $10K bonus
- Voice (Muse Voice Transcribe): on-call engineer talks to the agent
- Vision (Muse Spark): agent reads topology diagrams / dashboard screenshots
- Slack + Mail notifiers, extra failure scenarios

### Rack Vision — point your phone at the rack

The on-site technician opens the netmedic web page on their phone, points the camera at a rack /
switch / patch panel, and the agent finds physical problems by **cross-checking what it sees with
live data from the devices**.

```
Phone camera (web page, <input capture>, no app)
  → Muse Spark vision: identify devices, port numbers, cables, link LEDs, labels
  → SAM 3.1: segment each port / cable / LED for precise localisation + annotated overlay
  → agent tools fetch ground truth:
       interface state & counters, switch running-config, LLDP neighbors,
       expected cabling map (cabling.yaml: "sw1 port 12 ↔ r3 to-r4")
  → cross-check → findings, drawn on the photo:
       "fibre plugged in port 14, config + cabling map expect it in port 12"
       "port 7 LED off but interface admin-up in config → cable/SFP issue"
       "unlabelled cable in port 3: LLDP says it goes to r2"
  → feeds the normal incident pipeline (diagnosis → remediation → report)
```

- **Why it matters:** many outages are physical (wrong port, unseated SFP, bent fibre); remote
  agents are blind to them. This closes the loop between the NOC and the person in the datacenter.
- **Meta tooling:** Muse Spark multimodal + SAM 3.1 + (optional) Muse Voice Transcribe for
  hands-free questions — goes well beyond a basic text integration (25% of the score).
- **New tools:** `analyze_rack_photo(image)`, `segment_ports(image)`, `switch_config(device)`,
  `lldp_neighbors(device)`, `cabling_map(device)`.
- **Demo:** real photo of a physical switch / patch panel + `cabling.yaml` mapping physical ports to
  lab links → pull a cable (or use `chaos.sh link-down`) → photo → agent points at the exact port.
- **Open question:** physical hardware available for the demo (switch, patch panel, homelab rack)?

## Schedule

### Week 1 — MVP

| Day | Goal |
|---|---|
| **Tue Oct 27** | Repo, lab, Muse Spark client with tool calling, SSH tools → agent diagnoses a failure on its own. *Agents 101 session, 12 PM ET* |
| **Wed Oct 28** | Runbooks, 3 scenarios, remediation + safe apply + policy (auto / approval). *Agents 102 session, 12 PM ET* |
| **Thu Oct 29** | Live web UI, Telegram, Discord, incident report → full end-to-end demo |
| **Fri Oct 30** (daytime) | Stabilize, minimal README, push everything. **Checkpoint: a demoable MVP exists before the weekend.** *Fireworks session, 12 PM ET* |

*Fri evening → Sun evening: off.*

### Week 2 — Extras, polish, submit

| Day | Goal |
|---|---|
| **Mon Nov 2** | Phase 2 extras: **Rack Vision** (phone photo + SAM 3.1 + config cross-check) first, then open weights, voice, Slack / Mail, more scenarios |
| **Tue Nov 3** | Freeze features, final README (clearly state what was built during the hackathon), rehearse demo, record 3-min video. Last day for submission support questions |
| **Wed Nov 4** | Final fixes, X post, **submit before noon**; the rest of the day is buffer |

## To Prepare

- [ ] Meta API key (credits requested, pending) + read docs on tool-calling format (OpenAI-compatible?)
- [ ] 4 NixOS VMs on Proxmox, SSH key access, IP list
- [ ] Telegram bot (@BotFather) + Discord bot
- [ ] Status of DGX Spark access / Baseten credits

## Hackathon Reminders

- Deadline is **9:00 PM ET = 3:00 AM Paris time (night of Wed → Thu)** — aim for Wed noon anyway
- Code & commits start **Oct 27** (building period) — commit regularly as proof of new work
- Repo must be public; 3-minute demo video required; list all contributors on submission page
- Judging: Impact 30% · Use of Meta AI tooling 25% · Demo 25% · Technical depth 20%
- Bonuses: Most Viral on X ($20K, engagement until Nov 8) · Best open-weight build ($10K) · Community vote ($10K) · Best Agentic ($5K)
- Questions → Discord `#office-hours` (10–11 AM ET weekdays) / `#questions`

## Progress Log

### Tue Oct 27 — done
- Repo scaffold (Python, `uv`, Nix devShell), Meta Model API verified (`https://api.meta.ai/v1`, OpenAI-compatible, `muse-spark-1.3`)
- Lab runs **locally** as 4 QEMU VMs (no root): `lab/lab.sh up|down|ps|status|ssh <r> [cmd]`, `lab-reset` on routers
- Agent loop with 12 validated read-only tools + `submit_diagnosis` (structured output)
- First runbook: `bgp-session-down`
- ✅ Agent diagnosed an injected wrong-peer-AS fault on its own in ~14 s with correct root cause and evidence

### Next (Wed Oct 28)
- Detection: watcher (BGP state / loopback reachability / DNS) + `POST /api/alerts` webhook
- Remediation: typed actions (`edit_bird_config`, `set_interface`, `remove_firewall_rule`, `restart_service`)
- Safe apply: backup → `configure check` → `configure timeout` → verify → `confirm` | `undo`
- Modes: `approval` (default) / `auto` (low risk only)
- Chaos script with 3 scenarios
