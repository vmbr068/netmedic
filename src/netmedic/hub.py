"""Fan-out of events to live subscribers (web UI over SSE today, chat bots later)."""

from __future__ import annotations

import asyncio
import json
from collections import deque
from typing import Any

from .events import Event

# Long tool outputs are useful in reports, not in a live feed.
_MAX_OUTPUT = 600


def _slim(event: Event) -> dict[str, Any]:
    data = dict(event.data)
    if isinstance(data.get("output"), str) and len(data["output"]) > _MAX_OUTPUT:
        data["output"] = data["output"][:_MAX_OUTPUT] + "\n…"
    return {"kind": event.kind, "ts": event.ts, "data": data}


class EventHub:
    def __init__(self, history: int = 400):
        self._subscribers: set[asyncio.Queue[str]] = set()
        # Events of the current/last incident, replayed to late subscribers. "state" is kept apart.
        self._history: deque[str] = deque(maxlen=history)
        self._state: str | None = None

    async def publish(self, event: Event) -> None:
        message = json.dumps(_slim(event), default=str)
        if event.kind == "state":
            self._state = message
        else:
            if event.kind == "incident_opened":
                self._history.clear()
            self._history.append(message)
        for queue in list(self._subscribers):
            if queue.qsize() < 1000:  # drop slow consumers' backlog rather than block the agent
                queue.put_nowait(message)

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue()
        if self._state:
            queue.put_nowait(self._state)
        for message in self._history:
            queue.put_nowait(message)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)
