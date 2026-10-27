"""HTTP API: receive external alerts (Alertmanager or generic JSON) and expose watcher status."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException

from .watcher import Watcher


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


def create_app(watcher: Watcher) -> FastAPI:
    app = FastAPI(title="netmedic")

    @app.post("/api/alerts", status_code=202)
    async def post_alert(payload: dict[str, Any]) -> dict[str, Any]:
        text = alert_text(payload)
        if not text:
            raise HTTPException(400, "no firing alert or summary in payload")
        await watcher.alerts.put(text[:2000])
        return {"queued": text[:2000]}

    @app.get("/api/status")
    async def status() -> dict[str, Any]:
        return {
            "healthy": not watcher.symptoms,
            "busy": watcher.busy,
            "baseline_learned": watcher.baseline is not None,
            "symptoms": [s.text for s in watcher.symptoms],
        }

    return app
