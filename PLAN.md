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
| Notifications | **Web UI** (desktop + phone); Telegram optional. Discord / Slack / Mail cut |
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

## Demo Goals (revised Tue Oct 27 evening)

1. **Ultra robust**: the live demo must not fail. Measured, not hoped: an eval harness replays every
   failure scenario many times and reports success rate, MTTR and cost.
2. **Rack Vision with AR**: point an iPhone at a rack, see faults highlighted on the live video,
   cross-checked with live device data.

Cut to make room: Discord, Slack, Mail notifiers, Kubernetes. The web UI (works on the phone)
covers approvals; Telegram only if time is left.

## Robustness

- **Eval harness** `netmedic eval`: every chaos scenario × N runs → success rate, time to detect,
  time to resolve, tool calls, tokens/cost, failure reasons. Results table in the README.
- **API resilience**: retries with backoff on 429/5xx/timeouts, per-call and per-incident timeouts,
  graceful "escalate to human" instead of crashing.
- **Providers (plugins)**: tools + actions + checks + probes grouped per domain:
  `network` (BIRD, interfaces, routes, nftables, DNS) and `linux` (systemd services, disk, CPU/memory,
  journald). Same agent / plan / verify / rollback core for all domains.
- **More scenarios** (beyond BGP): service crash loop, disk full breaking a daemon, MTU mismatch,
  blackhole static route, firewall drop, multi-fault meltdowns.
- **Auth**: the server is reachable from the LAN for the phone → access token required for the UI
  and every write API (approve, mode, alerts).
- **Demo safety net**: rehearsed script, `chaos.sh` scenarios known to pass in eval, recorded backup
  takes of each segment.

## Rack Vision — point your iPhone at the rack

The technician opens the netmedic page on their iPhone (Safari, local network, HTTPS), points the
camera at a rack / switch / patch panel, and sees problems **drawn on the live video**, found by
cross-checking what the camera sees with live data from the devices.

```
iPhone Safari (getUserMedia, rear camera, HTTPS on the LAN)
  → every ~1-2 s (or on tap) a frame is sent to netmedic
  → Muse Spark vision: identify device, port numbering, cables, link LEDs, labels
  → SAM 3.1: precise boxes / masks for ports, cables, LEDs
  → agent tools fetch ground truth: interface states & counters, switch config,
       LLDP neighbours, expected cabling map (cabling.yaml: "sw1 port 12 ↔ r3 uplink")
  → findings drawn as AR overlay on the live video (canvas over <video>):
       "port 12: no cable, cabling map expects r3-uplink here"
       "port 7 LED off but interface admin-up → cable/SFP issue"
       "cable in port 14 belongs in port 12 (label r3-uplink)"
  → findings feed the normal incident pipeline (diagnosis → remediation → report)
```

- **iPhone → no WebXR**: "AR" = live camera with overlays re-anchored at each analysis (1-2 s).
  Overlays may lag when the phone moves fast between analyses; tap-to-freeze for a crisp view.
- **HTTPS on the LAN**: Safari only opens the camera in a secure context → local CA generated by
  netmedic, root certificate installed and trusted on the iPhone once (documented).
- **Hardware**: the user has physical equipment (model TBD, not reachable from the dev machine yet).
  Develop against photos + a device adapter interface; plug the real switch in when available
  (SSH/SNMP adapter for its model).
- **Meta tooling**: Muse Spark multimodal + SAM 3.1 (+ optional Muse Voice Transcribe:
  "what's wrong with this rack?") — well beyond a basic text integration (25% of the score).
- **Demo**: unplug a real cable → watcher detects the port down → point the iPhone at the rack →
  the empty port is circled on the video with "plug r3-uplink back into port 12" → fixed → green.

## Optional (only if everything above is solid)

- Open weights backend (Muse Spark Open / Glimmer on DGX Spark or Baseten) → $10K bonus
- Telegram alerts + approvals
- Kubernetes provider

## Schedule

### Week 1

| Day | Goal |
|---|---|
| **Tue Oct 27** | ✅ Lab, agent, safe remediation, automatic detection, multi-root-cause plans, web UI (far ahead of the original plan) |
| **Wed Oct 28** | **Robustness**: API retries/timeouts, eval harness, fix every failure it finds; providers refactor + `linux` provider and new scenarios; token auth. *Agents 102, 12 PM ET (17:00 Paris)* |
| **Thu Oct 29** | **Rack Vision core**: HTTPS on the LAN + local CA, iPhone camera page, frame → Muse Spark vision + SAM 3.1 → overlay; cabling map; device adapter interface |
| **Fri Oct 30** (daytime) | Rack Vision AR overlay polish + link to incidents; eval run on everything. **Checkpoint: robust demo before the weekend.** *Fireworks session, 12 PM ET* |

*Fri evening → Sun evening: off.*

### Week 2

| Day | Goal |
|---|---|
| **Mon Nov 2** | Plug the real hardware into Rack Vision (switch adapter for its model); optional items if time |
| **Tue Nov 3** | Feature freeze, final eval run, README (built-during-hackathon statement, eval table), rehearse demo ×5, record 3-min video + backup takes |
| **Wed Nov 4** | Final fixes, X post, **submit before noon**; the rest of the day is buffer |

## To Prepare

- [x] Meta API key + credits
- [ ] Rotate the Meta API key before the repo goes public (it was pasted in a chat)
- [ ] Test `sops -d secrets.yaml` with the GPG card
- [ ] Hardware for Rack Vision: switch model, management access (SSH/SNMP), cables + labels
- [ ] Photos of the rack/switch (front, ports, labels) to develop the vision pipeline before Monday
- [ ] Install the netmedic local CA on the iPhone (Thursday)
- [ ] Status of DGX Spark access / Baseten credits (optional)

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
- Chaos script (`lab/chaos.sh`, 5 scenarios + reset)
- ✅ Safe remediation (pulled forward from Wed): typed actions + typed checks, BIRD `configure check` → `configure timeout` → verify → `confirm` | rollback, `netmedic fix --mode approval|auto`, Markdown incident reports in `reports/`
- ✅ `fix --mode auto` resolved bgp-peer-as (6 s), link-down (5 s, from a vague latency alert) and dns-firewall autonomously; executor tested on wrong fix (rolled back) and invalid config (rejected)

- ✅ Detection (pulled forward): `netmedic watch` probes BGP, loopback reachability, DNS and best-path drift vs a learned baseline every 5 s; 2-poll confirmation, 20 s settle after incidents, max attempts then escalation; `POST /api/alerts` (Alertmanager or generic) + `GET /api/status`. link-down injected → detected and fixed autonomously in 51 s; fake alert on healthy network → "no remediation"
- ✅ Multi-root-cause plans: diagnosis = ordered plan (one fix per independent root cause, each verified/rolled back on its own) + alternatives. `chaos.sh meltdown` (3 simultaneous faults, ring split in two) fixed in ONE incident, 116 s, 47 tool calls (was 3 incidents, 325 s, 118 calls)

- ✅ Web UI (pulled forward from Thu): live topology, symptoms by kind, live incident feed (SSE), approve/reject from the browser, auto/approval switch, report a problem, incident history

### Wed Oct 28
- Enterprise lab (8 routers, OSPF + iBGP RR + dual-homed upstreams + branch) with 8 hard chaos scenarios; ring kept as fallback topology
- Escalation: issues outside our control end as ESCALATED and their symptoms are acknowledged (no re-investigation loop)
- ✅ Rack Vision core: SAM 3.1 fast pass (empty ports on live video, 2.7-5 s) + Muse Spark vision deep pass (~20 s) cross-checked with live symptoms; every "empty port" claim verified by SAM (confirmed / unclear / disputed) after catching Spark hallucinating under prompt pressure; /vision mobile page
- Eval on enterprise: run 1 = 12/16 (failures traced to a wrong default file name, a too strict route check, a too strict eval criterion); run 2 on the 4 problem scenarios = 6/8 (one stalled API call, one post-fix second incident) → tighter API timeouts, per-run timelines in eval
- Cost per resolved incident: $0.002-0.016 (contributor tier + 40-70 % cache hits)
