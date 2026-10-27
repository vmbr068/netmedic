"""HTTP API + web UI: live event stream (SSE), external alerts, approvals, mode, reports."""

from __future__ import annotations

import asyncio
import re
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse, PlainTextResponse,
                               RedirectResponse, StreamingResponse)
from pydantic import BaseModel

from .approvals import ApprovalBroker
from .hub import EventHub
from .watcher import Watcher

WEB_DIR = Path(__file__).parent / "web"
_REPORT = re.compile(r"^[0-9]{8}-[0-9]{6}-incident\.md$")
_STATUS = re.compile(r"^\*\*Status:\*\* (.+?)\s*$", re.M)
_DURATION = re.compile(r"^\*\*Duration:\*\* ([0-9.]+)s", re.M)
_TITLE = re.compile(r"^## Summary\n(.+)$", re.M)
COOKIE = "netmedic_token"
_DENIED = """<!doctype html><meta name="viewport" content="width=device-width">
<body style="background:#0b0f14;color:#e6edf3;font:16px system-ui;padding:24px">
<h2>netmedic</h2><p>Access denied. Open the link printed by <code>netmedic watch</code>
(scan its QR code with your phone).</p>"""


def alert_text(payload: dict[str, Any]) -> str:
    """Accept an Alertmanager webhook ({"alerts": [...]}) or a generic {"summary": "..."}."""
    if isinstance(payload.get("alerts"), list):
        parts = []
        for a in payload["alerts"]:
            if a.get("status", "firing") != "firing":
                continue
            labels, ann = a.get("labels", {}), a.get("annotations", {})
            name = labels.get("alertname", "alert")
            desc = ann.get("summary") or ann.get("description") or ""
            where = ", ".join(f"{k}={v}" for k, v in labels.items() if k != "alertname")
            parts.append(f"{name} ({where}): {desc}".strip())
        return "; ".join(parts)
    return str(payload.get("summary") or payload.get("message") or "")


class ModeIn(BaseModel):
    mode: str


class ApprovalIn(BaseModel):
    approve: bool


def create_app(
    watcher: Watcher,
    hub: EventHub,
    broker: ApprovalBroker,
    reports_dir: Path = Path("reports"),
    token: str | None = None,
    ca_cert: Path | None = None,
) -> FastAPI:
    """`token`: if set, required for everything except /ca.crt — via ?token= on the first visit
    (then a cookie, so EventSource works), a cookie, or an `Authorization: Bearer` header."""
    app = FastAPI(title="netmedic")

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if token is None or request.url.path == "/ca.crt":
            return await call_next(request)
        given = request.query_params.get("token")
        if given is not None and request.url.path == "/" and secrets.compare_digest(given, token):
            resp = RedirectResponse("/", status_code=303)
            resp.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=7 * 86400,
                            secure=request.url.scheme == "https")
            return resp
        header = request.headers.get("authorization", "")
        supplied = request.cookies.get(COOKIE) or (header[7:] if header.lower().startswith("bearer ") else "")
        if supplied and secrets.compare_digest(supplied, token):
            return await call_next(request)
        if request.url.path == "/":
            return HTMLResponse(_DENIED, status_code=401)
        return JSONResponse({"detail": "unauthorized"}, status_code=401)

    @app.get("/ca.crt", include_in_schema=False)
    async def ca() -> FileResponse:
        if ca_cert is None or not ca_cert.exists():
            raise HTTPException(404, "HTTPS is not enabled")
        return FileResponse(ca_cert, media_type="application/x-x509-ca-cert", filename="netmedic-ca.crt")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/events")
    async def events() -> StreamingResponse:
        async def stream():
            queue = hub.subscribe()
            try:
                while True:
                    try:
                        message = await asyncio.wait_for(queue.get(), timeout=15)
                        yield f"data: {message}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                hub.unsubscribe(queue)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        return {**watcher.snapshot(), "pending_approvals": broker.pending}

    @app.post("/api/alerts", status_code=202)
    async def post_alert(payload: dict[str, Any]) -> dict[str, Any]:
        text = alert_text(payload)
        if not text:
            raise HTTPException(400, "no firing alert or summary in payload")
        await watcher.alerts.put(text[:2000])
        return {"queued": text[:2000]}

    @app.post("/api/mode")
    async def set_mode(body: ModeIn) -> dict[str, str]:
        if body.mode not in ("auto", "approval"):
            raise HTTPException(400, "mode must be 'auto' or 'approval'")
        watcher.cfg.mode = body.mode
        return {"mode": body.mode}

    @app.post("/api/approvals/{request_id}")
    async def approve(request_id: int, body: ApprovalIn) -> dict[str, Any]:
        if not broker.resolve(request_id, body.approve):
            raise HTTPException(404, "no such pending approval")
        return {"id": request_id, "approved": body.approve}

    @app.get("/api/reports")
    async def reports() -> list[dict[str, Any]]:
        if not reports_dir.is_dir():
            return []
        out = []
        for path in sorted(reports_dir.glob("*-incident.md"), reverse=True)[:50]:
            text = path.read_text()
            m, d, t = _STATUS.search(text), _DURATION.search(text), _TITLE.search(text)
            out.append({
                "name": path.name,
                "status": m.group(1) if m else "?",
                "duration": float(d.group(1)) if d else None,
                "summary": t.group(1)[:160] if t else "",
            })
        return out

    @app.get("/api/reports/{name}", response_class=PlainTextResponse)
    async def report(name: str) -> str:
        if not _REPORT.match(name) or not (reports_dir / name).is_file():
            raise HTTPException(404, "no such report")
        return (reports_dir / name).read_text()

    return app
