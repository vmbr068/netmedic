"""Investigation loop: Muse Spark + tool calling, guided by runbooks, ending in a structured Diagnosis."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI

from .config import Inventory, Settings
from .models import DIAGNOSIS_TOOL, Diagnosis
from .runbooks import Runbook
from .tools import Toolbox

SYSTEM_PROMPT = """\
You are netmedic, an autonomous network reliability engineer on call for a production network.
You investigate incidents using read-only diagnostic tools on the routers, then submit a diagnosis.

Rules:
- Ground every conclusion in tool output. Quote the exact evidence (log lines, states, counters).
- Check both ends of a link or session. Work layer by layer (L1/L2 -> L3 -> transport -> control plane).
- Run independent checks in parallel (several tool calls in one turn).
- Follow the matching runbook when one applies, but deviate when evidence points elsewhere.
- Stop as soon as the root cause is proven; do not run redundant commands.
- Remediations must be concrete, minimal and reversible (what to change, on which router).
- Finish by calling submit_diagnosis exactly once.

Network inventory:
{inventory}

Runbooks:
{runbooks}
"""


@dataclass
class Event:
    kind: str  # thinking | tool_call | tool_result | diagnosis | error
    data: dict[str, Any]
    ts: float = field(default_factory=time.time)


EventSink = Callable[[Event], Awaitable[None]]


async def _noop(_: Event) -> None:
    pass


class Agent:
    def __init__(
        self,
        settings: Settings,
        inventory: Inventory,
        toolbox: Toolbox,
        runbooks: list[Runbook],
        on_event: EventSink = _noop,
        max_steps: int = 20,
    ):
        self.settings = settings
        self.client = AsyncOpenAI(api_key=settings.api_key, base_url=settings.api_base)
        self.toolbox = toolbox
        self.on_event = on_event
        self.max_steps = max_steps
        inv = "\n".join(f"- {r.name}: {r.host}, AS{r.asn}" for r in inventory.routers.values())
        self.system = SYSTEM_PROMPT.format(
            inventory=inv, runbooks="\n".join(rb.render() for rb in runbooks) or "(none)"
        )

    async def _complete(self, messages: list[dict[str, Any]]) -> Any:
        extra = {"reasoning_effort": self.settings.reasoning_effort} if self.settings.reasoning_effort else {}
        resp = await self.client.chat.completions.create(
            model=self.settings.model,
            messages=messages,
            tools=[*self.toolbox.schemas(), DIAGNOSIS_TOOL],
            tool_choice="auto",
            **extra,
        )
        return resp.choices[0].message

    async def _run_tool(self, call: Any) -> dict[str, Any]:
        name = call.function.name
        try:
            args = json.loads(call.function.arguments or "{}")
        except json.JSONDecodeError as e:
            args, output = {}, f"error: invalid JSON arguments: {e}"
        else:
            await self.on_event(Event("tool_call", {"id": call.id, "name": name, "args": args}))
            output = await self.toolbox.call(name, args)
        await self.on_event(Event("tool_result", {"id": call.id, "name": name, "args": args, "output": output}))
        return {"role": "tool", "tool_call_id": call.id, "content": output}

    async def investigate(self, incident: str) -> Diagnosis:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system},
            {"role": "user", "content": f"Incident: {incident}\nInvestigate and submit your diagnosis."},
        ]
        for _ in range(self.max_steps):
            msg = await self._complete(messages)
            messages.append(msg.model_dump(exclude_none=True))
            if msg.content:
                await self.on_event(Event("thinking", {"text": msg.content}))
            calls = msg.tool_calls or []
            if not calls:
                messages.append({"role": "user", "content": "Continue, or call submit_diagnosis if you are done."})
                continue

            final = next((c for c in calls if c.function.name == "submit_diagnosis"), None)
            if final is not None:
                try:
                    diagnosis = Diagnosis.model_validate_json(final.function.arguments)
                except ValueError as e:
                    messages.append({"role": "tool", "tool_call_id": final.id, "content": f"error: {e}"})
                    for c in calls:
                        if c is not final:
                            messages.append({"role": "tool", "tool_call_id": c.id, "content": "skipped"})
                    continue
                await self.on_event(Event("diagnosis", diagnosis.model_dump()))
                return diagnosis

            messages.extend(await asyncio.gather(*(self._run_tool(c) for c in calls)))

        await self.on_event(Event("error", {"text": f"no diagnosis after {self.max_steps} steps"}))
        raise RuntimeError(f"agent did not reach a diagnosis within {self.max_steps} steps")
