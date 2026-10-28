// Live incident, rebuilt from the server-sent events of the agent (pipeline.py, agent.py, remediate.py).
import type { ServerEvent } from "./api"

export const STAGES = ["Detected", "Investigating", "Plan", "Applying", "Verified"] as const

export type Remediation = { title: string; risk: string; root_cause: string; description: string; actions: unknown[] }
export type Diagnosis = { summary: string; root_cause: string; plan: Remediation[]; alternatives: { title: string }[]; escalation?: string }
export type Usage = { model: string; llm_calls: number; tool_calls: number; tokens: number; cost_usd: number }

export type Tone = "info" | "warn" | "ok" | "bad"
export type StepIcon = "decision" | "action" | "pass" | "fail" | "committed" | "rollback" | "error" | "escalate"

export type FeedItem =
  | { type: "opened"; ts: number; text: string }
  | { type: "model"; ts: number; text: string }
  | { type: "think"; ts: number; text: string }
  | { type: "tool"; ts: number; id: string; name: string; args: string; output: string | null }
  | { type: "diagnosis"; ts: number; dx: Diagnosis }
  | { type: "approval"; ts: number; id: number; remediation: Remediation; approved: boolean | null }
  | { type: "step"; ts: number; tone: Tone; icon: StepIcon; text: string }
  | { type: "closed"; ts: number; status: string; tone: Tone }

export type Incident = {
  active: boolean
  start: number | null
  end: number | null
  stage: number
  failed: boolean
  feed: FeedItem[]
  usage: Usage | null
}

export const emptyIncident: Incident = { active: false, start: null, end: null, stage: -1, failed: false, feed: [], usage: null }

const STEP: Record<string, [Tone, StepIcon]> = {
  decision: ["warn", "decision"], action: ["warn", "action"], committed: ["ok", "committed"],
  rollback: ["bad", "rollback"], error: ["bad", "error"], escalate: ["bad", "escalate"],
}

export function reduce(inc: Incident, ev: ServerEvent): Incident {
  const d = ev.data, ts = ev.ts
  const at = (stage: number) => Math.max(inc.stage, stage)
  const add = (item: FeedItem, patch: Partial<Incident> = {}) => ({ ...inc, ...patch, feed: [...inc.feed, item] })
  switch (ev.kind) {
    case "incident_opened":
      return { ...emptyIncident, active: true, start: ts, stage: 0,
               feed: [{ type: "opened", ts, text: String(d.text).replace(/^Automated detection at [0-9:]+\.\n?/, "") }] }
    case "model":
      return add({ type: "model", ts, text: d.model })
    case "thinking":
      return add({ type: "think", ts, text: d.text }, { stage: at(1) })
    case "tool_call":
      return add({ type: "tool", ts, id: d.id, name: d.name, output: null,
                   args: Object.entries(d.args || {}).map(([k, v]) => `${k}=${v}`).join(", ") }, { stage: at(1) })
    case "tool_result":
      return { ...inc, feed: inc.feed.map((f) => (f.type === "tool" && f.id === d.id ? { ...f, output: d.output } : f)) }
    case "diagnosis":
      return add({ type: "diagnosis", ts, dx: d }, { stage: at(2) })
    case "approval_request":
      return add({ type: "approval", ts, id: d.id, remediation: d.remediation, approved: null })
    case "approval_resolved":
      return { ...inc, feed: inc.feed.map((f) => (f.type === "approval" && f.id === d.id ? { ...f, approved: d.approved } : f)) }
    case "check":
      return add({ type: "step", ts, tone: d.ok ? "ok" : "bad", icon: d.ok ? "pass" : "fail", text: d.text })
    case "usage":
      return { ...inc, usage: d }
    case "incident_closed": {
      const tone: Tone = !d.resolved ? "bad" : d.escalated ? "warn" : "ok"
      return add({ type: "closed", ts, status: d.status, tone },
                 { active: false, end: ts, stage: d.resolved ? STAGES.length : inc.stage, failed: !d.resolved })
    }
    default: {
      const step = STEP[ev.kind]
      if (!step) return inc
      const [tone, icon] = step
      const stage = ev.kind === "decision" || ev.kind === "action" ? at(3) : inc.stage
      return add({ type: "step", ts, tone, icon, text: d.text },
                 { stage, failed: inc.failed || ev.kind === "escalate" })
    }
  }
}
