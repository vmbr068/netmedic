// Shapes of the netmedic API (src/netmedic/server.py, watcher.py) and the derived network model.

export type RouterInfo = { asn: number | null; loopback: string | null; role: string | null; layer: number | null; reachable: boolean }
export type LinkEnd = { proto: string; state: string; neighbor?: string }
export type Link = { a: string; b: string; up: boolean; kind?: "ospf" | "ebgp"; ends: Record<string, LinkEnd> }
export type External = { router: string; proto: string; neighbor: string; asn: number | null; state: string }
export type Symptom = { text: string; kind: string; acknowledged: boolean }

export type Snapshot = {
  healthy: boolean
  busy: boolean
  mode: "auto" | "approval"
  baseline_learned: boolean
  settling: boolean
  routers: Record<string, RouterInfo>
  sessions: Record<string, Record<string, string>>
  links: Link[]
  externals: External[]
  symptoms: Symptom[]
}

export type Report = { name: string; status: string; duration: number | null; summary: string }
export type ServerEvent = { kind: string; data: any; ts: number }

export type Status = "ok" | "warn" | "bad"
export type Device = RouterInfo & { name: string; up: number; total: number; issues: Symptom[]; status: Status }

export type Model = {
  devices: Device[]
  links: Link[]
  externals: External[]
  online: number
  sessUp: number
  sessTotal: number
  score: number
}

export function model(s: Snapshot): Model {
  const devices: Device[] = Object.entries(s.routers).map(([name, info]) => {
    const sessions = Object.values(s.sessions[name] || {})
    const issues = s.symptoms.filter((x) => x.text.startsWith(name + ":"))
    return {
      name, ...info, issues,
      up: sessions.filter((x) => x.startsWith("Established")).length,
      total: sessions.length,
      status: !info.reachable ? "bad" : issues.length ? "warn" : "ok",
    }
  })
  const sessUp = devices.reduce((a, d) => a + d.up, 0)
  const sessTotal = devices.reduce((a, d) => a + d.total, 0)
  const online = devices.filter((d) => d.reachable).length
  const score = Math.max(0, Math.min(100, Math.round(
    100 - (devices.length - online) * 25 - (sessTotal - sessUp) * 6 - s.symptoms.length * 1.5)))
  return { devices, links: s.links || [], externals: s.externals || [], online, sessUp, sessTotal, score }
}

async function send(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText)
  return r.json()
}

export const api = {
  reports: async (): Promise<Report[]> => (await fetch("/api/reports")).json(),
  report: async (name: string): Promise<string> => (await fetch(`/api/reports/${name}`)).text(),
  setMode: (mode: string) => send("/api/mode", { mode }),
  approve: (id: number, approve: boolean) => send(`/api/approvals/${id}`, { approve }),
  alert: (summary: string) => send("/api/alerts", { summary }),
}

export const fmtDur = (s: number | null | undefined) =>
  s == null ? "–" : s < 90 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`
export const hhmmss = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour12: false })

export function reportTime(name: string): Date | null {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}

export function reportTone(status: string): Status {
  if (/ESCALATED/.test(status) || /^PARTIAL/.test(status)) return "warn"
  return /^(RESOLVED|NO ACTION)/.test(status) ? "ok" : "bad"
}

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()
