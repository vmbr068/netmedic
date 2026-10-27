"""Events emitted while netmedic works, consumed by the CLI today and the web UI / chat bots later."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Event:
    # thinking | tool_call | tool_result | diagnosis | action | check | rollback | committed | error
    kind: str
    data: dict[str, Any]
    ts: float = field(default_factory=time.time)


EventSink = Callable[[Event], Awaitable[None]]


async def noop_sink(_: Event) -> None:
    pass
