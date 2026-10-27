"""Investigation loop: Muse Spark + tool calling, guided by runbooks, ending in a structured Diagnosis."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from openai import AsyncOpenAI

from .config import Inventory, Settings
from .events import Event, EventSink, noop_sink
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
- Finish by calling submit_diagnosis exactly once.

Remediations:
- You cannot change anything yourself. Each remediation lists typed actions that netmedic applies
  safely (backup, BIRD configure check + timeout, automatic rollback) and typed checks it runs to
  prove the fix. If any check fails, everything is rolled back.
- Keep actions minimal: fix the root cause only, on the router where it lives.
- edit_bird_config only touches /var/lib/netagent/<file>; `find` must be copied verbatim from the
  bird_config output (exact whitespace) and occur exactly once.
- For nftables, use rule handles shown by firewall_rules; never delete the nixos-fw table.
- Large outages often have SEVERAL independent root causes at once. Account for every symptom:
  keep investigating until each one is explained, then put one fix per root cause in `plan`.
  All plan steps are applied in order in a single pass, each verified on its own; a failed step is
  rolled back alone, the others are kept.
- Each step's checks must only depend on that step and the steps before it (a ping across a link
  fixed by a later step would fail). Order the plan accordingly: transport/links first, then
  routing, then services.
- Checks must prove the symptom fixed by that step is gone (session Established, route present via
  the expected protocol, ping, DNS resolution), on the affected routers.
- Put other options you considered in `alternatives` (never applied).
- If the symptoms have already cleared (e.g. routing reconverging after a recent change) and no
  root cause remains, say so and submit an empty plan: never change a healthy network.

Network inventory:
{inventory}

Runbooks:
{runbooks}
"""


class Agent:
    def __init__(
        self,
        settings: Settings,
        inventory: Inventory,
        toolbox: Toolbox,
        runbooks: list[Runbook],
        on_event: EventSink = noop_sink,
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
