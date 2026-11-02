import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import { ToastQueue } from "@react-spectrum/s2"

import { api, model, titleCase, type Report, type ServerEvent, type Snapshot } from "./api"
import { emptyIncident, reduce } from "./incident"

// One connection to the server-sent events of `netmedic watch`, shared by every page.
export function useNetmedic() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [incident, dispatch] = useReducer(reduce, emptyIncident)
  const [reports, setReports] = useState<Report[]>([])
  const [health, setHealth] = useState<number[]>([])
  const lastHealth = useRef(0)

  const loadReports = useCallback(async () => {
    try { setReports(await api.reports()) } catch { /* server restarting */ }
  }, [])

  useEffect(() => {
    const es = new EventSource("/api/events")
    const since = Date.now() / 1000  // the server replays the last incident on connect: no toasts for those
    es.onmessage = (m) => {
      const ev: ServerEvent = JSON.parse(m.data)
      if (ev.kind === "state") {
        setSnapshot(ev.data)
        const now = Date.now()
        if (now - lastHealth.current > 2000) {  // one point every 2 s, 6 minutes of history
          lastHealth.current = now
          setHealth((h) => [...h.slice(-179), model(ev.data).score])
        }
        return
      }
      dispatch(ev)
      if (ev.ts >= since - 1) notify(ev)
      if (ev.kind === "incident_closed") loadReports()
    }
    loadReports()
    return () => es.close()
  }, [loadReports])

  // The derived network model, shared by every page (recomputed only when the snapshot changes).
  const net = useMemo(() => snapshot && model(snapshot), [snapshot])

  return { snapshot, net, incident, reports, health }
}

function notify(ev: ServerEvent) {
  const d = ev.data
  switch (ev.kind) {
    case "incident_opened":
      ToastQueue.negative("Incident detected", { timeout: 6000 })
      break
    case "approval_request":
      ToastQueue.info(`Approval required · ${d.remediation.title}`, { timeout: 8000 })
      break
    case "incident_closed": {
      const text = titleCase(d.status)
      if (!d.resolved) ToastQueue.negative(text, { timeout: 6000 })
      else if (d.escalated) ToastQueue.info(text, { timeout: 6000 })
      else ToastQueue.positive(text, { timeout: 6000 })
      break
    }
  }
}

export type Netmedic = ReturnType<typeof useNetmedic>
