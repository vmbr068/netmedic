"""On-site physical checks: the agent asks a technician for a Rack Vision photo and waits for the scan."""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from typing import Any

from .events import Event, EventSink, noop_sink


@dataclass
class PhotoRequest:
    id: int
    router: str
    interface: str
    reason: str
    answer: asyncio.Future[dict[str, Any]] = field(repr=False, compare=False)

    @property
    def target(self) -> str:
        return f"{self.router} {self.interface}".strip()

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "router": self.router, "interface": self.interface, "reason": self.reason, "target": self.target}


class OnsiteBroker:
    """Same pattern as ApprovalBroker, but the answer is a Rack Vision scan sent from the phone."""

    def __init__(self, on_event: EventSink = noop_sink, timeout: float = 180.0):
        self.on_event = on_event
        self.timeout = timeout
        self._pending: dict[int, PhotoRequest] = {}
        self._ids = itertools.count(1)

    async def request(self, router: str, interface: str, reason: str) -> str:
        """Publish the request, wait for a scan; returns the findings as text for the agent."""
        req = PhotoRequest(next(self._ids), router, interface, reason, asyncio.get_running_loop().create_future())
        self._pending[req.id] = req
        await self.on_event(Event("vision_request", {**req.public(), "text": f"Rack Vision photo needed: {req.target} ({reason})"}))
        try:
            scan = await asyncio.wait_for(req.answer, self.timeout)
        except asyncio.TimeoutError:
            await self.on_event(Event("vision_resolved", {"id": req.id, "ok": False, "text": f"no photo of {req.target} received"}))
            return (f"No photo received within {int(self.timeout)} s: the physical layer of {req.target} is unverified. "
                    "Do not ask again.")
        finally:
            self._pending.pop(req.id, None)
        findings = scan.get("findings", [])
        await self.on_event(Event("vision_resolved", {
            "id": req.id, "ok": True, "summary": scan.get("summary", ""), "findings": len(findings),
            "text": f"Rack Vision photo of {req.target}: {scan.get('summary', '')}",
        }))
        lines = [f"On-site photo of {req.target} analysed by Rack Vision.", f"Summary: {scan.get('summary', '')}"]
        for f in findings:
            sam = f" (segmentation: {f['verdict']})" if f.get("verdict") else ""
            lines.append(f"- [{f.get('severity', 'info')}] {f.get('title', '')}: {f.get('detail', '')}{sam}")
        if not findings:
            lines.append("- no physical anomaly visible")
        return "\n".join(lines)

    def get(self, request_id: int) -> PhotoRequest | None:
        return self._pending.get(request_id)

    def resolve(self, request_id: int, scan: dict[str, Any]) -> bool:
        req = self._pending.get(request_id)
        if req is None or req.answer.done():
            return False
        req.answer.set_result(scan)
        return True
