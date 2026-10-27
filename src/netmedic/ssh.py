"""SSH transport to lab routers. Commands are always argv lists, never raw shell strings."""

from __future__ import annotations

import asyncio
import shlex
from dataclasses import dataclass
from pathlib import Path

import asyncssh

from .config import Inventory


@dataclass
class CommandResult:
    router: str
    command: str
    exit_status: int
    stdout: str
    stderr: str

    def as_text(self, limit: int = 6000) -> str:
        out = self.stdout if len(self.stdout) <= limit else self.stdout[:limit] + "\n…[truncated]"
        text = f"$ {self.command}\n(exit {self.exit_status})\n{out}"
        if self.stderr.strip():
            text += f"\n[stderr]\n{self.stderr[:2000]}"
        return text


class RouterPool:
    """Keeps one SSH connection per router, opened lazily."""

    def __init__(self, inventory: Inventory, timeout: float = 30.0):
        self.inventory = inventory
        self.timeout = timeout
        self._conns: dict[str, asyncssh.SSHClientConnection] = {}
        self._lock = asyncio.Lock()

    async def _conn(self, router: str) -> asyncssh.SSHClientConnection:
        async with self._lock:
            conn = self._conns.get(router)
            if conn is None or conn.is_closed():
                r = self.inventory.routers[router]
                ssh = self.inventory.ssh
                keys = [str(Path(ssh.key).expanduser())] if ssh.key else None
                # Lab hosts are ephemeral VMs: host key checking is disabled on purpose.
                conn = await asyncssh.connect(
                    r.host, port=r.port or ssh.port, username=ssh.user, client_keys=keys, known_hosts=None
                )
                self._conns[router] = conn
            return conn

    async def run(self, router: str, argv: list[str], timeout: float | None = None) -> CommandResult:
        command = shlex.join(argv)
        try:
            conn = await self._conn(router)
            res = await conn.run(command, check=False, timeout=timeout or self.timeout)
            return CommandResult(router, command, res.exit_status or 0, str(res.stdout), str(res.stderr))
        except (OSError, asyncssh.Error, asyncio.TimeoutError) as e:
            return CommandResult(router, command, -1, "", f"{type(e).__name__}: {e}")

    async def close(self) -> None:
        for conn in self._conns.values():
            conn.close()
        self._conns.clear()
