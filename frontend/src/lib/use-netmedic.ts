import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { toast } from "sonner"

import { api, model, titleCase, type Report, type ServerEvent, type Snapshot } from "./api"
import { emptyIncident, reduce } from "./incident"

export type Connection = "connecting" | "live" | "lost"

// One connection to the server-sent events of `netmedic watch`, shared by every page.
export function useNetmedic() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [incident, dispatch] = useReducer(reduce, emptyIncident)
  const [reports, setReports] = useState<Report[]>([])
  const [health, setHealth] = useState<number[]>([])
  const [connection, setConnection] = useState<Connection>("connecting")
  const lastHealth = useRef(0)

  const loadReports = useCallback(async () => {
    try { setReports(await api.reports()) } catch { /* server restarting */ }
  }, [])

  useEffect(() => {
    const es = new EventSource("/api/events")
    es.onopen = () => setConnection("live")
    es.onerror = () => setConnection("lost")
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
      notify(ev)
      if (ev.kind === "incident_closed") loadReports()
    }
    loadReports()
    return () => es.close()
  }, [loadReports])

  return { snapshot, incident, reports, health, connection, loadReports }
}

function notify(ev: ServerEvent) {
  const d = ev.data
  switch (ev.kind) {
    case "incident_opened":
      toast.error("Incident detected")
      break
    case "approval_request":
      toast.warning("Approval required", { description: d.remediation.title })
      break
    case "incident_closed": {
      const text = titleCase(d.status)
      if (!d.resolved) toast.error(text)
      else if (d.escalated) toast.warning(text)
      else toast.success(text)
      break
    }
  }
}

export type Netmedic = ReturnType<typeof useNetmedic>
