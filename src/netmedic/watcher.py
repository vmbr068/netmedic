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
import re
import time
from dataclasses import dataclass

from .config import Inventory, Settings
from .events import Event, EventSink, noop_sink
from .pipeline import Approver, handle_incident
from .ssh import RouterPool

_ROUTE = re.compile(r"^(\S+)\s+unicast \[(\S+)")
_PING_LOOP = 'for t in "$@"; do ping -c1 -W1 "$t" >/dev/null 2>&1 && echo "$t ok" || echo "$t fail"; done'


@dataclass(frozen=True)
class Symptom:
    key: str
    text: str
    kind: str  # bgp | reach | dns | path


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

    # --- probes ----------------------------------------------------------------------------

    async def _probe_router(self, name: str) -> tuple[list[Symptom], dict[str, str]]:
        loopbacks = {r.loopback: r.name for r in self.inventory.routers.values() if r.loopback and r.name != name}
        protos, routes, pings, *dns = await asyncio.gather(
            self.pool.run(name, ["birdc", "show", "protocols"]),
            self.pool.run(name, ["birdc", "show", "route", "primary"]),
            self.pool.run(name, ["sh", "-c", _PING_LOOP, "sh", *loopbacks]),
            *(self.pool.run(name, ["dig", "+short", "+time=1", "+tries=1", n]) for n in self.cfg.dns_names),
        )
        if protos.exit_status != 0:
            return [Symptom(f"router:{name}", f"{name}: unreachable or BIRD not responding ({protos.stderr.strip()})", "bgp")], {}

        found: list[Symptom] = []
        for line in protos.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 4 and parts[1] == "BGP":
                info = " ".join(parts[5:]) or parts[3]
                if not info.startswith("Established"):
                    found.append(Symptom(f"bgp:{name}:{parts[0]}", f"{name}: BGP session {parts[0]} is {info}", "bgp"))
        for line in pings.stdout.splitlines():
            target, _, status = line.partition(" ")
            if status == "fail":
                found.append(Symptom(f"reach:{name}:{target}",
                                     f"{name}: cannot reach {loopbacks.get(target, '?')} loopback {target}", "reach"))
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

    async def _run_incident(self, text: str) -> bool:
        self.busy = True
        await self.on_event(Event("incident_opened", {"text": text}))
        try:
            result = await handle_incident(
                text, self.settings, self.inventory, self.pool, self.cfg.mode, self.approve, self.on_event
            )
            return result.resolved
        except Exception as e:  # keep watching whatever happens in one incident
            await self.on_event(Event("error", {"text": f"incident pipeline failed: {e}"}))
            return False
        finally:
            self.busy = False
            self._seen.clear()
            # Let routing reconverge before judging the result of the fix.
            self._settle_until = time.monotonic() + self.cfg.settle

    async def tick(self) -> None:
        symptoms, tables = await self.probe()
        healthy = not symptoms
        if healthy and self.baseline is None and all(tables.values()):
            self.baseline = tables
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

        if time.monotonic() < self._settle_until:
            self._seen.clear()
            return

        alert = None if self.alerts.empty() else self.alerts.get_nowait()
        confirmed = [s for s in symptoms if self._seen[s.key] >= self.cfg.confirm_polls]
        if alert is None and not confirmed:
            return

        fingerprint = frozenset(s.key for s in confirmed)
        if alert is None and self._attempts.get(fingerprint, 0) >= self.cfg.max_attempts:
            if self._attempts[fingerprint] == self.cfg.max_attempts:
                self._attempts[fingerprint] += 1
                await self.on_event(Event("escalate", {"text": "still broken after "
                                          f"{self.cfg.max_attempts} attempts — escalating to a human"}))
            return
        self._attempts[fingerprint] = self._attempts.get(fingerprint, 0) + 1
        await self._run_incident(self._incident_text(symptoms, alert))

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
