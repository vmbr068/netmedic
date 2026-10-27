"""Safe execution of a remediation: snapshot -> apply -> verify -> commit, or roll back.

BIRD changes go through `configure check` then `configure timeout`, so even if netmedic dies
mid-way, BIRD reverts on its own. Every other action records the previous state and knows how to
restore it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from .events import Event, EventSink, noop_sink
from .models import (
    Action,
    BgpEstablished,
    Check,
    DeleteNftRule,
    DeleteNftTable,
    DnsResolves,
    EditBirdConfig,
    PingOk,
    Remediation,
    RestartService,
    RoutePresent,
    SetInterface,
)
from .ssh import CommandResult, RouterPool

AGENT_DIR = "/var/lib/netagent"
_FILE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.conf$")
_IDENT = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
PROTECTED_TABLES = {"nixos-fw"}

Undo = Callable[[], Awaitable[None]]


class RemediationError(Exception):
    pass


@dataclass
class CheckResult:
    check: Check
    ok: bool
    detail: str


@dataclass
class Outcome:
    success: bool
    log: list[str] = field(default_factory=list)
    checks: list[CheckResult] = field(default_factory=list)
    duration: float = 0.0


def _ident(value: str, what: str) -> str:
    if not _IDENT.match(value):
        raise RemediationError(f"invalid {what}: {value!r}")
    return value


class Executor:
    def __init__(
        self,
        pool: RouterPool,
        on_event: EventSink = noop_sink,
        verify_timeout: float = 60.0,
        bird_confirm_timeout: int = 120,
    ):
        self.pool = pool
        self.on_event = on_event
        self.verify_timeout = verify_timeout
        self.bird_confirm_timeout = bird_confirm_timeout
        self._bird_pending: set[str] = set()

    # --- helpers ---------------------------------------------------------------------------

    async def _run(self, router: str, argv: list[str], input: str | None = None) -> CommandResult:
        if router not in self.pool.inventory.routers:
            raise RemediationError(f"unknown router {router!r}")
        return await self.pool.run(router, argv, input=input)

    async def _must(self, router: str, argv: list[str], input: str | None = None) -> str:
        res = await self._run(router, argv, input=input)
        if res.exit_status != 0:
            raise RemediationError(f"{router}: `{res.command}` failed: {res.stderr.strip() or res.stdout.strip()}")
        return res.stdout

    async def _log(self, outcome: Outcome, kind: str, text: str, **data) -> None:
        outcome.log.append(text)
        await self.on_event(Event(kind, {"text": text, **data}))

    async def _write_file(self, router: str, path: str, content: str) -> None:
        await self._must(router, ["sh", "-c", 'cat > "$0.tmp" && mv "$0.tmp" "$0"', path], input=content)

    # --- actions ---------------------------------------------------------------------------

    async def _edit_bird_config(self, a: EditBirdConfig, outcome: Outcome) -> Undo:
        if not _FILE.match(a.file):
            raise RemediationError(f"invalid file name: {a.file!r}")
        path = f"{AGENT_DIR}/{a.file}"
        original = await self._must(a.router, ["cat", path])
        count = original.count(a.find)
        if count != 1:
            raise RemediationError(f"{a.router}:{path}: snippet to replace found {count} times (expected 1)")
        await self._write_file(a.router, path, original.replace(a.find, a.replace, 1))

        async def restore() -> None:
            await self._write_file(a.router, path, original)
            if a.router in self._bird_pending:
                await self._run(a.router, ["birdc", "configure", "undo"])
                self._bird_pending.discard(a.router)
            await self._run(a.router, ["birdc", "configure"])

        check = await self._run(a.router, ["birdc", "configure", "check"])
        if "Configuration OK" not in check.stdout:
            await self._write_file(a.router, path, original)
            raise RemediationError(f"{a.router}: new BIRD config rejected: {check.stdout.strip()}")
        await self._log(outcome, "action", f"{a.router}: birdc configure check -> OK")

        out = await self._must(a.router, ["birdc", "configure", "timeout", str(self.bird_confirm_timeout)])
        self._bird_pending.add(a.router)
        await self._log(
            outcome, "action",
            f"{a.router}: applied with `configure timeout {self.bird_confirm_timeout}` "
            f"(BIRD auto-reverts unless confirmed): {out.strip().splitlines()[-1]}",
        )
        return restore

    async def _set_interface(self, a: SetInterface, outcome: Outcome) -> Undo:
        iface = _ident(a.interface, "interface")
        info = json.loads(await self._must(a.router, ["ip", "-j", "link", "show", "dev", iface]))[0]
        prev_state = "up" if "UP" in info.get("flags", []) else "down"
        prev_mtu = info.get("mtu")
        argv = ["ip", "link", "set", "dev", iface, a.state]
        if a.mtu:
            argv += ["mtu", str(min(max(a.mtu, 576), 9000))]
        await self._must(a.router, argv)
        await self._log(outcome, "action", f"{a.router}: {' '.join(argv)} (was {prev_state}, mtu {prev_mtu})")

        async def restore() -> None:
            await self._run(a.router, ["ip", "link", "set", "dev", iface, prev_state, "mtu", str(prev_mtu)])

        return restore

    async def _nft_snapshot(self, router: str, family: str, table: str) -> str:
        return await self._must(router, ["nft", "list", "table", family, table])

    async def _delete_nft_rule(self, a: DeleteNftRule, outcome: Outcome) -> Undo:
        family, table, chain = (_ident(x, "nft name") for x in (a.family, a.table, a.chain))
        snapshot = await self._nft_snapshot(a.router, family, table)
        await self._must(a.router, ["nft", "delete", "rule", family, table, chain, "handle", str(int(a.handle))])
        await self._log(outcome, "action", f"{a.router}: nft delete rule {family} {table} {chain} handle {a.handle}")

        async def restore() -> None:
            # Atomic swap back to the snapshot of the table.
            await self._run(a.router, ["nft", "-f", "-"], input=f"delete table {family} {table}\n{snapshot}")

        return restore

    async def _delete_nft_table(self, a: DeleteNftTable, outcome: Outcome) -> Undo:
        family, table = _ident(a.family, "nft family"), _ident(a.table, "nft table")
        if table in PROTECTED_TABLES:
            raise RemediationError(f"refusing to delete protected table {table!r}")
        snapshot = await self._nft_snapshot(a.router, family, table)
        await self._must(a.router, ["nft", "delete", "table", family, table])
        await self._log(outcome, "action", f"{a.router}: nft delete table {family} {table}")

        async def restore() -> None:
            await self._run(a.router, ["nft", "-f", "-"], input=snapshot)

        return restore

    async def _restart_service(self, a: RestartService, outcome: Outcome) -> Undo:
        await self._must(a.router, ["systemctl", "restart", a.service])
        await self._log(outcome, "action", f"{a.router}: systemctl restart {a.service}")

        async def restore() -> None:  # a restart has no meaningful undo
            pass

        return restore

    async def _apply(self, action: Action, outcome: Outcome) -> Undo:
        handlers = {
            "edit_bird_config": self._edit_bird_config,
            "set_interface": self._set_interface,
            "delete_nft_rule": self._delete_nft_rule,
            "delete_nft_table": self._delete_nft_table,
            "restart_service": self._restart_service,
        }
        return await handlers[action.type](action, outcome)

    # --- checks ----------------------------------------------------------------------------

    async def _check(self, c: Check) -> CheckResult:
        if isinstance(c, BgpEstablished):
            res = await self._run(c.router, ["birdc", "show", "protocols", _ident(c.protocol, "protocol")])
            return CheckResult(c, "Established" in res.stdout, res.stdout.strip().splitlines()[-1] if res.stdout else res.stderr)
        if isinstance(c, RoutePresent):
            prefix = str(ipaddress.ip_network(c.prefix, strict=False))
            res = await self._run(c.router, ["birdc", "show", "route", "for", prefix, "primary"])
            line = next((l for l in res.stdout.splitlines() if "unicast" in l), "")
            ok = bool(line) and (c.protocol is None or f"[{c.protocol} " in line)
            return CheckResult(c, ok, line.strip() or "no route")
        if isinstance(c, PingOk):
            target = str(ipaddress.ip_address(c.target))
            res = await self._run(c.router, ["ping", "-c", "2", "-W", "1", target])
            return CheckResult(c, res.exit_status == 0, (res.stdout.strip().splitlines() or ["no output"])[-1])
        if isinstance(c, DnsResolves):
            res = await self._run(c.router, ["dig", "+short", "+time=2", "+tries=1", _ident(c.name, "name")])
            return CheckResult(c, res.exit_status == 0 and bool(res.stdout.strip()), res.stdout.strip() or "no answer")
        raise RemediationError(f"unknown check {c!r}")

    async def _verify(self, checks: list[Check], outcome: Outcome) -> list[CheckResult]:
        deadline = time.monotonic() + self.verify_timeout
        while True:
            results = await asyncio.gather(*(self._check(c) for c in checks))
            if all(r.ok for r in results) or time.monotonic() > deadline:
                break
            await asyncio.sleep(3)
        for r in results:
            await self._log(outcome, "check", f"{'PASS' if r.ok else 'FAIL'} {r.check.type} "
                            f"{r.check.model_dump(exclude={'type'})}: {r.detail}", ok=r.ok)
        return list(results)

    # --- entry point -----------------------------------------------------------------------

    async def execute(self, rem: Remediation) -> Outcome:
        outcome = Outcome(success=False)
        start = time.monotonic()
        undos: list[Undo] = []
        try:
            for action in rem.actions:
                undos.append(await self._apply(action, outcome))
            outcome.checks = await self._verify(rem.checks, outcome)
            outcome.success = all(r.ok for r in outcome.checks)
        except (RemediationError, ValueError, KeyError) as e:
            await self._log(outcome, "error", f"remediation aborted: {e}")

        if outcome.success:
            for router in sorted(self._bird_pending):
                await self._must(router, ["birdc", "configure", "confirm"])
                await self._log(outcome, "committed", f"{router}: birdc configure confirm")
            self._bird_pending.clear()
            await self._log(outcome, "committed", "all checks passed, change kept")
        else:
            for undo in reversed(undos):
                await undo()
            await self._log(outcome, "rollback", f"rolled back {len(undos)} action(s), network restored to previous state")
        outcome.duration = time.monotonic() - start
        return outcome
