"""Automatic detection: probe the network, turn persistent symptoms into incidents, run the pipeline.

Probes (every `watch.interval` seconds, all routers in parallel):
- BGP: every BGP protocol must be Established
- reachability: every router pings every other router's loopback
- DNS: configured names must resolve from every router
- paths: best route per prefix is compared with a baseline learned while the network was healthy
  (catches silent failures such as an import filter that drops routes while sessions stay up)
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass

from .config import Inventory, Settings
from .events import Event, EventSink, noop_sink
from .pipeline import Approver, handle_incident
from .ssh import RouterPool

_ROUTE = re.compile(r"^(\S+)\s+unicast \[(\S+)")
_NEIGHBOR = re.compile(r"^\s+Neighbor (address|AS):\s+(\S+)")
_OSPF_NBR = re.compile(r"^(\d+\.\d+\.\d+\.\d+)\s+\d+\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)")
_PING_LOOP = 'for t in "$@"; do ping -c1 -W1 "$t" >/dev/null 2>&1 && echo "$t ok" || echo "$t fail"; done'


def _parse_protocols(text: str) -> dict[str, dict]:
    """Parse `birdc show protocols all`: BGP sessions with state, neighbour address and AS."""
    out: dict[str, dict] = {}
    current = None
    for line in text.splitlines():
        if line and not line[0].isspace():
            parts = line.split()
            current = parts[0] if len(parts) >= 4 and parts[1] == "BGP" else None
            if current:
                out[current] = {"state": " ".join(parts[5:]) or parts[3]}
        elif current and (m := _NEIGHBOR.match(line)):
            key, value = m.groups()
            out[current]["neighbor" if key == "address" else "asn"] = value if key == "address" else int(value)
    return out


@dataclass(frozen=True)
class Symptom:
    key: str
    text: str
    kind: str  # bgp | ospf | reach | dns | path


class Watcher:
    def __init__(
        self,
        settings: Settings,
        inventory: Inventory,
        pool: RouterPool,
        approve: Approver,
        on_event: EventSink = noop_sink,
    ):
        self.settings = settings
        self.cfg = settings.watch
        self.inventory = inventory
        self.pool = pool
        self.approve = approve
        self.on_event = on_event
        self.alerts: asyncio.Queue[str] = asyncio.Queue()
        self.baseline: dict[str, dict[str, str]] | None = None
        self.symptoms: list[Symptom] = []
        self.busy = False
        self._seen: dict[str, int] = {}
        self._attempts: dict[frozenset[str], int] = {}
        self._settle_until = 0.0
        # Symptoms left after an incident that ended "escalated" or "no action": known, a human
        # has been told, do not re-investigate them until they change or clear.
        self.acknowledged: set[str] = set()
        self._ack_next = False
        self._task: asyncio.Task | None = None
        # router -> BGP protocol -> state text (e.g. "Established", "Active Socket: ...")
        self.sessions: dict[str, dict[str, str]] = {}
        self.reachable: dict[str, bool] = {}
        # Discovery: BGP neighbour address/AS per session, IPv4 addresses per router (kept when a
        # router becomes unreachable, so its links can still be drawn as down).
        self.session_info: dict[str, dict[str, dict]] = {}
        self.addresses: dict[str, set[str]] = {}
        # OSPF adjacencies per router (router-id -> state/interface), and the Full ones learned
        # with the baseline: losing one is a symptom even when redundancy hides it.
        self.ospf: dict[str, dict[str, dict]] = {}
        self.ospf_baseline: dict[str, set[str]] | None = None
        self.loopback_owner = {r.loopback: r.name for r in inventory.routers.values() if r.loopback}

    # --- probes ----------------------------------------------------------------------------

    async def _probe_router(self, name: str) -> tuple[list[Symptom], dict[str, str]]:
        loopbacks = {r.loopback: r.name for r in self.inventory.routers.values() if r.loopback and r.name != name}
        targets = [t for t in self.inventory.targets if t not in loopbacks]
        protos, addrs, routes, ospf, pings, *dns = await asyncio.gather(
            self.pool.run(name, ["birdc", "show", "protocols", "all"]),
            self.pool.run(name, ["ip", "-j", "-4", "addr"]),
            self.pool.run(name, ["birdc", "show", "route", "primary"]),
            self.pool.run(name, ["birdc", "show", "ospf", "neighbors"]),
            self.pool.run(name, ["sh", "-c", _PING_LOOP, "sh", *loopbacks, *targets]),
            *(self.pool.run(name, ["dig", "+short", "+time=1", "+tries=1", n]) for n in self.cfg.dns_names),
        )
        self.reachable[name] = protos.exit_status == 0
        if protos.exit_status != 0:
            self.sessions[name] = {}
            return [Symptom(f"router:{name}", f"{name}: unreachable or BIRD not responding ({protos.stderr.strip()})", "bgp")], {}

        found: list[Symptom] = []
        info_by_proto = _parse_protocols(protos.stdout)
        sessions = {proto: d["state"] for proto, d in info_by_proto.items()}
        for proto, state in sessions.items():
            if not state.startswith("Established"):
                found.append(Symptom(f"bgp:{name}:{proto}", f"{name}: BGP session {proto} is {state}", "bgp"))
        self.sessions[name] = sessions
        self.session_info[name] = info_by_proto
        try:
            self.addresses[name] = {
                a["local"] for i in json.loads(addrs.stdout or "[]") for a in i.get("addr_info", [])
                if a.get("scope") == "global"
            }
        except json.JSONDecodeError:
            pass
        self.ospf[name] = {
            m.group(1): {"state": m.group(2), "iface": m.group(3), "ip": m.group(4)}
            for l in ospf.stdout.splitlines() if (m := _OSPF_NBR.match(l))
        }
        for line in pings.stdout.splitlines():
            target, _, status = line.partition(" ")
            if status == "fail":
                what = f"{loopbacks[target]} loopback" if target in loopbacks else "external target"
                found.append(Symptom(f"reach:{name}:{target}", f"{name}: cannot reach {what} {target}", "reach"))
        for n, res in zip(self.cfg.dns_names, dns):
            if res.exit_status != 0 or not res.stdout.strip():
                found.append(Symptom(f"dns:{name}:{n}", f"{name}: DNS name {n} does not resolve", "dns"))

        table = {m.group(1): m.group(2) for l in routes.stdout.splitlines() if (m := _ROUTE.match(l))}
        return found, table

    async def probe(self) -> tuple[list[Symptom], dict[str, dict[str, str]]]:
        names = list(self.inventory.routers)
        results = await asyncio.gather(*(self._probe_router(n) for n in names))
        symptoms = [s for found, _ in results for s in found]
        tables = {n: table for n, (_, table) in zip(names, results)}
        if self.ospf_baseline:
            for router, rids in self.ospf_baseline.items():
                if not self.reachable.get(router):
                    continue
                current = self.ospf.get(router, {})
                for rid in sorted(rids):
                    nbr = current.get(rid)
                    if nbr is None or not nbr["state"].startswith("Full"):
                        peer = self.loopback_owner.get(rid, rid)
                        where = f" on {nbr['iface']}" if nbr else ""
                        state = nbr["state"] if nbr else "gone"
                        symptoms.append(Symptom(f"ospf:{router}:{rid}",
                                                f"{router}: OSPF neighbor {peer} ({rid}){where} is {state} (normally Full)", "ospf"))
        if self.baseline:
            for router, base in self.baseline.items():
                now = tables.get(router, {})
                if not now:
                    continue  # router unreachable: already reported
                for prefix, proto in base.items():
                    current = now.get(prefix)
                    if current != proto:
                        what = f"now via {current}" if current else "missing"
                        symptoms.append(Symptom(f"path:{router}:{prefix}",
                                                f"{router}: best route to {prefix} {what} (normally via {proto})", "path"))
        return symptoms, tables

    # --- loop ------------------------------------------------------------------------------

    def _incident_text(self, symptoms: list[Symptom], alert: str | None = None) -> str:
        lines = [f"Automated detection at {time.strftime('%H:%M:%S')}."]
        if alert:
            lines.append(f"External alert: {alert}")
        if symptoms:
            lines.append("Symptoms currently observed by the monitoring probes:")
            lines += [f"- {s.text}" for s in symptoms]
        return "\n".join(lines)

    async def _run_incident(self, text: str, tier: int = 0) -> bool:
        await self.on_event(Event("incident_opened", {"text": text, "tier": tier}))
        try:
            result = await handle_incident(
                text, self.settings, self.inventory, self.pool, self.cfg.mode, self.approve, self.on_event, tier=tier
            )
            self._ack_next = result.escalated or not result.diagnosis.plan
            return result.resolved
        except Exception as e:  # keep watching whatever happens in one incident
            await self.on_event(Event("error", {"text": f"incident pipeline failed: {e}"}))
            return False
        finally:
            self.busy = False
            self._seen.clear()
            # Let routing reconverge before judging the result of the fix.
            self._settle_until = time.monotonic() + self.cfg.settle

    def links(self) -> tuple[list[dict], list[dict]]:
        """Discovered topology: router-to-router links (matched on neighbour addresses, whatever the
        session names) and external peers (neighbours no managed router owns)."""
        owners: dict[str, set[str]] = {}
        for router, addrs in self.addresses.items():
            for a in addrs:
                owners.setdefault(a, set()).add(router)
        owner = {a: next(iter(rs)) for a, rs in owners.items() if len(rs) == 1}  # skip shared addresses
        links: dict[tuple[str, str], dict] = {}
        externals = []

        def add(router: str, peer: str, kind: str, proto: str, state: str, neighbor: str | None) -> None:
            a, b = sorted((router, peer))
            link = links.setdefault((a, b), {"a": a, "b": b, "kind": kind, "ends": {}})
            link["ends"][router] = {"proto": proto, "state": state, "neighbor": neighbor}

        # Physical adjacencies from OSPF (neighbour router-id = its loopback).
        for router, nbrs in self.ospf.items():
            for rid, n in nbrs.items():
                peer = self.loopback_owner.get(rid) or owner.get(n["ip"])
                if peer and peer != router:
                    add(router, peer, "ospf", "OSPF", n["state"], n["ip"])
        # eBGP sessions; iBGP sessions are logical (over loopbacks), not links.
        for router, sessions in self.session_info.items():
            local_asn = self.inventory.routers[router].asn
            for proto, d in sessions.items():
                if local_asn is not None and d.get("asn") == local_asn:
                    continue
                peer = owner.get(d.get("neighbor", ""))
                if peer and peer != router:
                    add(router, peer, "ebgp", proto, d["state"], d.get("neighbor"))
                else:
                    externals.append({"router": router, "proto": proto, "neighbor": d.get("neighbor"),
                                      "asn": d.get("asn"), "state": d["state"]})
        for link in links.values():
            link["up"] = all(e["state"].startswith(("Established", "Full")) for e in link["ends"].values())
        return list(links.values()), externals

    def snapshot(self) -> dict:
        """Live state for the web UI."""
        return {
            "healthy": not self.symptoms,
            "busy": self.busy,
            "mode": self.cfg.mode,
            "baseline_learned": self.baseline is not None,
            "settling": time.monotonic() < self._settle_until,
            "routers": {
                r.name: {"asn": r.asn, "loopback": r.loopback, "role": r.role, "layer": r.layer,
                         "reachable": self.reachable.get(r.name, False)}
                for r in self.inventory.routers.values()
            },
            "sessions": self.sessions,
            "links": (topo := self.links())[0],
            "externals": topo[1],
            "symptoms": [{"text": s.text, "kind": s.kind, "acknowledged": s.key in self.acknowledged}
                         for s in self.symptoms],
        }

    def _start_incident(self, text: str, tier: int = 0) -> None:
        # Runs in the background so probes (and the live topology) keep updating during the fix.
        self.busy = True
        self._task = asyncio.create_task(self._run_incident(text, tier))

    async def tick(self) -> None:
        symptoms, tables = await self.probe()
        healthy = not symptoms
        if healthy and self.baseline is None and all(tables.values()):
            self.baseline = tables
            self.ospf_baseline = {
                r: {rid for rid, n in nbrs.items() if n["state"].startswith("Full")} for r, nbrs in self.ospf.items()
            }
            await self.on_event(Event("watch", {"text": "network healthy — baseline of best paths learned "
                                                f"({sum(map(len, tables.values()))} routes)"}))

        keys = {s.key for s in symptoms}
        self._seen = {k: self._seen.get(k, 0) + 1 for k in keys}
        if {s.key for s in self.symptoms} != keys:
            text = "network healthy" if healthy else f"{len(symptoms)} symptom(s): " + "; ".join(s.text for s in symptoms)
            await self.on_event(Event("watch", {"text": text, "symptoms": [s.text for s in symptoms]}))
            if healthy:
                self._attempts.clear()
        self.symptoms = symptoms
        await self.on_event(Event("state", self.snapshot()))

        if self.busy or time.monotonic() < self._settle_until:
            self._seen.clear()
            return

        self.acknowledged &= keys  # cleared symptoms are no longer acknowledged
        if self._ack_next:
            self._ack_next = False
            if keys - self.acknowledged:
                self.acknowledged |= keys
                await self.on_event(Event("watch", {"text": f"{len(keys)} symptom(s) acknowledged as outside our "
                                                    "control: watching them, not re-investigating"}))

        alert = None if self.alerts.empty() else self.alerts.get_nowait()
        confirmed = [s for s in symptoms
                     if self._seen[s.key] >= self.cfg.confirm_polls and s.key not in self.acknowledged]
        if alert is None and not confirmed:
            return

        fingerprint = frozenset(s.key for s in confirmed)
        if alert is None and self._attempts.get(fingerprint, 0) >= self.cfg.max_attempts:
            if self._attempts[fingerprint] == self.cfg.max_attempts:
                self._attempts[fingerprint] += 1
                await self.on_event(Event("escalate", {"text": "still broken after "
                                          f"{self.cfg.max_attempts} attempts — escalating to a human"}))
            return
        attempt = self._attempts.get(fingerprint, 0)
        self._attempts[fingerprint] = attempt + 1
        if attempt:
            text = self._incident_text(symptoms, alert) + (
                f"\nPrevious attempt #{attempt} did not resolve this. Re-check your earlier conclusions.")
        else:
            text = self._incident_text(symptoms, alert)
        self._start_incident(text, tier=attempt)

    async def run(self) -> None:
        await self.on_event(Event("watch", {"text": f"watching {len(self.inventory.routers)} routers every "
                                            f"{self.cfg.interval:g}s (mode: {self.cfg.mode})"}))
        while True:
            started = time.monotonic()
            try:
                await self.tick()
            except Exception as e:
                await self.on_event(Event("error", {"text": f"probe failed: {e}"}))
            await asyncio.sleep(max(0.0, self.cfg.interval - (time.monotonic() - started)))
