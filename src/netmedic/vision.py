"""Rack Vision: find physical faults in a photo of a rack, cross-checked with live network data.

Two speeds, so the phone can show an AR-like overlay:
- ports():   SAM 3.1 segments empty and plugged ports in ~1-2 s -> boxes refreshed on the live video,
             kept glued to the ports between refreshes by motion tracking in the browser.
- trace():   Muse Spark follows the cable plugged at a tapped point -> polyline drawn over the video.
- analyze(): Muse Spark vision identifies devices, labels and anomalies, given what the network
             itself reports (active symptoms, expected cabling) -> findings anchored on SAM boxes.
All boxes are returned normalised to 0..1 (x1, y1, x2, y2) so the client can draw them at any size.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from pathlib import Path
from typing import Any

import yaml
from openai import AsyncOpenAI

from .config import Settings

_BOX = re.compile(r"<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=([0-9.]+))?\|>")

ANALYZE_PROMPT = """You are netmedic's Rack Vision, helping an on-site technician.
Look at this photo of network equipment and report what a network engineer must act on.

Live data from the network itself (ground truth to cross-check with the photo):
{context}

Return ONLY a JSON object:
{{"summary": "one sentence",
  "devices": [{{"name": "...", "type": "switch|router|patch_panel|server|firewall|other",
               "bbox": {{"x_min": 0, "y_min": 0, "x_max": 0, "y_max": 0}}}}],
  "findings": [{{"title": "short, actionable", "detail": "what you see and why it matters",
                "severity": "info|warning|critical", "related": "symptom / cabling entry it explains, or empty",
                "bbox": {{"x_min": 0, "y_min": 0, "x_max": 0, "y_max": 0}}}}]}}
Coordinates on a 0-1000 grid, (0,0) = top-left. Findings: unplugged or loose cables, empty ports
that the cabling plan expects to be used, wrong ports, link/status LEDs off or amber, damaged
cables, anything matching the live symptoms. Prefer few precise findings over many vague ones.

Be strictly faithful to the photo: the live data tells you where to look, never what to see.
- Only report what is clearly visible. If a port or label is not readable, say it is unclear.
- If the photo contradicts the live data, report the contradiction itself (e.g. "cable seated in
  port T-07 but the link is down: check the cable, transceiver or far end").
- Do not invent a finding just to explain a symptom.
- A finding's bbox must tightly enclose ONLY the port(s) or cable it is about, not the whole area:
  it is cross-checked by a segmentation model port by port.
"""


# SAM 3.1 takes one short noun phrase per call: both run in parallel for the live overlay.
PORT_PROMPTS = {"empty": "empty ethernet port", "plugged": "ethernet cable plug"}

TRACE_EFFORT = "minimal"  # same answers as "low" on test photos, twice as fast (~10 s)
TRACE_PROMPT = """A network technician tapped the point ({x}, {y}) on this photo (0-1000 grid, (0,0) = top-left).
Identify the port or connector at that point and follow its cable through the photo as far as you can see it.

Return ONLY a JSON object:
{{"start": "what is at the tapped point, e.g. 'patch panel port 37'",
  "path": [[x, y], ...],
  "end": "where the cable goes: the device and port it plugs into, or where it leaves the frame or disappears",
  "confidence": 0.0,
  "note": "short caveat if the route is ambiguous, else empty"}}
path: 6 to 25 points along the centre line of the cable, ordered from the tapped connector, on the 0-1000 grid.
Be strictly faithful to the photo: stop where you can no longer see this cable for sure (bundle, cable manager,
edge of the frame) and say so in "end"; never guess beyond. If no cable is plugged at that point, return an
empty path and say so in "start".
"""


def _json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    try:
        return json.loads(match.group(0)) if match else {}
    except json.JSONDecodeError:
        return {}


def load_cabling(path: Path = Path("cabling.yaml")) -> list[dict]:
    """Expected physical cabling, e.g. {device: sw1, port: 12, router: edge1, interface: to-core1}."""
    if not path.exists():
        return []
    return (yaml.safe_load(path.read_text()) or {}).get("cabling", [])


def network_context(snapshot: dict, cabling: list[dict]) -> str:
    """What the network reports right now, as short text for the vision prompt."""
    lines = []
    symptoms = [s for s in snapshot.get("symptoms", []) if not s.get("acknowledged")]
    if symptoms:
        lines.append("Active symptoms:")
        lines += [f"- {s['text']}" for s in symptoms]
    elif snapshot.get("baseline_learned"):
        lines.append("No active symptom: the network reports healthy.")
    down = [n for n, r in snapshot.get("routers", {}).items() if not r.get("reachable")]
    if down and snapshot.get("baseline_learned"):
        lines.append(f"Unreachable devices: {', '.join(down)}")
    if cabling:
        lines.append("Expected cabling (device port -> router interface):")
        lines += [f"- {c.get('device')} port {c.get('port')} -> {c.get('router')} {c.get('interface', '')}".rstrip()
                  for c in cabling]
    return "\n".join(lines)


def _norm_box(b: dict[str, Any]) -> list[float] | None:
    try:
        x1, y1, x2, y2 = (float(b[k]) / 1000 for k in ("x_min", "y_min", "x_max", "y_max"))
    except (KeyError, TypeError, ValueError):
        return None
    return [max(0, min(1, v)) for v in (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))]


def _overlap(a: list[float], b: list[float]) -> float:
    """Share of box b covered by box a."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max(1e-9, (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / area


class RackVision:
    def __init__(self, settings: Settings, model: str = "muse-spark-1.3-contributor", effort: str = "low"):
        self.client = AsyncOpenAI(api_key=settings.api_key, base_url=settings.api_base,
                                  max_retries=2, timeout=60)
        self.model = model
        self.effort = effort

    @staticmethod
    def _data_url(image: bytes, mime: str) -> str:
        return f"data:{mime};base64,{base64.b64encode(image).decode()}"

    async def segment(self, image: bytes, mime: str, prompt: str) -> list[dict]:
        """SAM 3.1: boxes for one short noun phrase, normalised."""
        resp = await self.client.responses.create(model="sam-3.1", input=[{
            "type": "message", "role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": self._data_url(image, mime)},
            ]}])
        out = []
        for x1, y1, x2, y2, w, h, conf in _BOX.findall(resp.output_text or ""):
            w, h = float(w), float(h)
            out.append({"box": [int(x1) / w, int(y1) / h, int(x2) / w, int(y2) / h],
                        "label": prompt, "score": float(conf) if conf else None})
        return out

    async def ports(self, image: bytes, mime: str = "image/jpeg") -> dict:
        start = time.monotonic()
        found = await asyncio.gather(*(self.segment(image, mime, prompt) for prompt in PORT_PROMPTS.values()))
        objects = [{**o, "kind": kind} for kind, objs in zip(PORT_PROMPTS, found) for o in objs]
        return {"objects": objects, "latency": round(time.monotonic() - start, 2)}

    async def trace(self, image: bytes, x: float, y: float, mime: str = "image/jpeg", plugged: bool = False) -> dict:
        """Follow the cable plugged at (x, y), normalised 0..1. Returns a normalised polyline.
        `plugged`: SAM 3.1 already saw a cable plug there (the client checks its live boxes first,
        so a tap on an empty port is answered without asking the language model)."""
        start = time.monotonic()
        prompt = TRACE_PROMPT.format(x=round(x * 1000), y=round(y * 1000))
        if plugged:
            prompt += "\nA segmentation model (SAM 3.1) detected a cable plug at the tapped point: a cable IS plugged there.\n"
        resp = await self.client.chat.completions.create(
            model=self.model, reasoning_effort=TRACE_EFFORT,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": self._data_url(image, mime)}},
            ]}],
        )
        data = _json(resp.choices[0].message.content or "")
        path = []
        for point in data.get("path") or []:
            try:
                path.append([max(0.0, min(1.0, float(point[0]) / 1000)), max(0.0, min(1.0, float(point[1]) / 1000))])
            except (TypeError, ValueError, IndexError):
                continue
        return {
            "start": data.get("start", ""), "end": data.get("end", ""), "note": data.get("note", ""),
            "confidence": data.get("confidence"), "path": path,
            "model": self.model, "latency": round(time.monotonic() - start, 2),
            "reasoning_tokens": getattr(getattr(resp.usage, "completion_tokens_details", None), "reasoning_tokens", None),
        }

    async def analyze(self, image: bytes, context: str, mime: str = "image/jpeg") -> dict:
        start = time.monotonic()
        resp = await self.client.chat.completions.create(
            model=self.model, reasoning_effort=self.effort,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": ANALYZE_PROMPT.format(context=context or "(no live data)")},
                {"type": "image_url", "image_url": {"url": self._data_url(image, mime)}},
            ]}],
        )
        data = _json(resp.choices[0].message.content or "")
        devices = [{**d, "box": _norm_box(d.get("bbox", {}))} for d in data.get("devices", [])]
        findings = [{**f, "box": _norm_box(f.get("bbox", {}))} for f in data.get("findings", [])]
        return {
            "summary": data.get("summary", ""),
            "devices": [d for d in devices if d["box"]],
            "findings": [f for f in findings if f["box"]],
            "model": self.model,
            "latency": round(time.monotonic() - start, 2),
        }

    async def scan(self, image: bytes, context: str, mime: str = "image/jpeg") -> dict:
        """Deep scan: Spark findings, each anchored on the precise SAM boxes it covers."""
        deep, fast = await asyncio.gather(self.analyze(image, context, mime), self.ports(image, mime))
        empty = [o for o in fast["objects"] if o["kind"] == "empty"]
        for f in deep["findings"]:
            f["anchors"] = [o["box"] for o in empty if _overlap(f["box"], o["box"]) > 0.5]
            f.update(_cross_check(f, empty))
        return {**deep, "objects": fast["objects"], "latency": max(deep["latency"], fast["latency"])}


_EMPTY_CLAIM = re.compile(r"\b(empty|unplugged|vacant|disconnected|no (patch )?cable|missing cable|not plugged)\b", re.I)


def _cross_check(finding: dict, objects: list[dict]) -> dict:
    """Two models, one truth: a vision-LLM claim about an empty port must be backed by SAM 3.1,
    which segments empty ports precisely. Language models can be swayed by the symptoms in their
    prompt; SAM only sees pixels. Score = share of the claimed area covered by SAM empty ports."""
    if not _EMPTY_CLAIM.search(f"{finding.get('title', '')} {finding.get('detail', '')}"):
        return {"verdict": "unverified", "verdict_note": "", "coverage": None}
    fb = finding["box"]
    area = max(1e-9, (fb[2] - fb[0]) * (fb[3] - fb[1]))
    coverage = sum(_intersection(fb, o["box"]) for o in objects) / area
    if coverage >= 0.25:
        verdict, note = "confirmed", "SAM 3.1 sees empty port(s) right there"
    elif coverage >= 0.08:
        verdict, note = "unclear", "SAM 3.1 only partly agrees: check these ports by hand"
    else:
        verdict, note = "disputed", "SAM 3.1 sees no empty port here: a cable is probably plugged in. Check it by hand."
    return {"verdict": verdict, "verdict_note": note, "coverage": round(coverage, 2)}


def _intersection(a: list[float], b: list[float]) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
