"""Human approval of remediation steps from any channel (web UI now, chat bots later)."""

from __future__ import annotations

import asyncio
import itertools

from .events import Event, EventSink, noop_sink
from .models import Remediation


class ApprovalBroker:
    def __init__(self, on_event: EventSink = noop_sink, timeout: float = 600.0):
        self.on_event = on_event
        self.timeout = timeout
        self._pending: dict[int, asyncio.Future[bool]] = {}
        self._ids = itertools.count(1)

    async def __call__(self, rem: Remediation) -> bool:
        """Approver for the pipeline: publish a request, wait for the first answer from any channel."""
        request_id = next(self._ids)
        future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self.on_event(Event("approval_request", {
            "id": request_id, "text": f"approval needed: {rem.title} (risk {rem.risk})",
            "remediation": rem.model_dump(),
        }))
        try:
            approved = await asyncio.wait_for(future, self.timeout)
            by = "human"
        except asyncio.TimeoutError:
            approved, by = False, "timeout"
        finally:
            self._pending.pop(request_id, None)
        await self.on_event(Event("approval_resolved", {
            "id": request_id, "approved": approved,
            "text": f"{'approved' if approved else 'rejected'} ({by}): {rem.title}",
        }))
        return approved

    def resolve(self, request_id: int, approved: bool) -> bool:
        future = self._pending.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(approved)
        return True

    @property
    def pending(self) -> list[int]:
        return list(self._pending)
