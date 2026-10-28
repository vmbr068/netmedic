import { useEffect, useRef, useState } from "react"
import { motion } from "motion/react"
import {
  AlertTriangle, Brain, Check, ChevronRight, CircleCheck, Cpu, Hand, Loader2, ShieldCheck, Terminal, Undo2, Wrench, X,
} from "lucide-react"

import { Dot, ToneBadge, softTone } from "@/components/status"
import { BlurFade } from "@/components/ui/blur-fade"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { api, fmtDur, hhmmss, titleCase } from "@/lib/api"
import { STAGES, type FeedItem, type Incident, type StepIcon, type Tone } from "@/lib/incident"
import { cn } from "@/lib/utils"

const RISK: Record<string, Tone> = { low: "ok", medium: "warn", high: "bad" }
const ICON: Record<StepIcon, typeof Check> = {
  decision: Hand, action: Wrench, pass: Check, fail: X, committed: CircleCheck, rollback: Undo2, error: AlertTriangle, escalate: AlertTriangle,
}

export function Stepper({ incident }: { incident: Incident }) {
  return (
    <ol className="flex items-center gap-1.5">
      {STAGES.map((label, i) => {
        const done = i < incident.stage || (i === incident.stage && !incident.active)
        const current = i === incident.stage && incident.active
        const failed = incident.failed && i === Math.min(incident.stage, STAGES.length - 1)
        return (
          <li key={label} className="flex flex-1 flex-col gap-1.5">
            <span className="h-1.5 overflow-hidden rounded-full bg-muted">
              <motion.span className={cn("block h-full rounded-full", failed ? "bg-destructive" : done ? "bg-success" : "bg-primary", current && "animate-pulse")}
                           initial={false} animate={{ width: failed || done ? "100%" : current ? "55%" : "0%" }}
                           transition={{ type: "spring", stiffness: 140, damping: 22 }} />
            </span>
            <span className={cn("text-[11px] text-muted-foreground", (done || current) && "text-foreground")}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function useElapsed(incident: Incident) {
  const [now, setNow] = useState(Date.now() / 1000)
  useEffect(() => {
    if (!incident.active) return
    const t = setInterval(() => setNow(Date.now() / 1000), 500)
    return () => clearInterval(t)
  }, [incident.active])
  if (incident.start == null) return null
  return (incident.end ?? now) - incident.start
}

export function IncidentFeed({ incident, className }: { incident: Incident; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [incident.feed])

  return (
    <div ref={ref} className={cn("overflow-y-auto", className)}
         onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      <div className="flex flex-col gap-0.5">
        {incident.feed.map((item, i) => <BlurFade key={i} duration={0.25} offset={4} blur="4px"><Item item={item} /></BlurFade>)}
      </div>
    </div>
  )
}

function Row({ icon: Icon, tone = "info", ts, children }: { icon: typeof Check; tone?: Tone; ts: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-md", softTone(tone))}><Icon className="size-3" /></span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      <time className="shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground tabular-nums">{hhmmss(ts)}</time>
    </div>
  )
}

function Item({ item }: { item: FeedItem }) {
  switch (item.type) {
    case "opened":
      return (
        <Row icon={AlertTriangle} tone="bad" ts={item.ts}>
          <p className="font-medium">Incident detected</p>
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{item.text}</p>
        </Row>
      )
    case "model":
      return <Row icon={Cpu} ts={item.ts}><span className="font-mono text-xs">{item.text}</span></Row>
    case "think":
      return <Row icon={Brain} ts={item.ts}><p className="text-muted-foreground">{item.text}</p></Row>
    case "tool":
      return (
        <Row icon={Terminal} tone="info" ts={item.ts}>
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left font-mono text-xs">
              <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className="truncate">{item.name}({item.args})</span>
              {item.output == null && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {item.output ?? ""}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </Row>
      )
    case "diagnosis":
      return (
        <div className="my-2 rounded-lg border bg-card p-3.5 text-sm">
          <p className="font-medium">{item.dx.summary}</p>
          <p className="mt-1 text-muted-foreground">{item.dx.root_cause}</p>
          {item.dx.plan.length > 0 && (
            <ol className="mt-3 flex flex-col gap-2.5">
              {item.dx.plan.map((step, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{step.title}</span>
                      <ToneBadge tone={RISK[step.risk] ?? "warn"}>{step.risk} risk</ToneBadge>
                    </div>
                    <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11px]">
                      {step.actions.map((a) => JSON.stringify(a)).join("\n")}
                    </pre>
                  </div>
                </div>
              ))}
            </ol>
          )}
        </div>
      )
    case "approval":
      return (
        <div className="my-2 rounded-lg border border-warning/40 bg-warning/5 p-3.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-warning" />
            <span className="font-medium">{item.remediation.title}</span>
            <ToneBadge tone={RISK[item.remediation.risk] ?? "warn"}>{item.remediation.risk} risk</ToneBadge>
          </div>
          <p className="mt-1 text-muted-foreground">{item.remediation.description}</p>
          {item.approved == null ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => api.approve(item.id, true)}><Check />Approve</Button>
              <Button size="sm" variant="outline" onClick={() => api.approve(item.id, false)}>Reject</Button>
            </div>
          ) : (
            <ToneBadge tone={item.approved ? "ok" : "bad"} className="mt-3">{item.approved ? "Approved" : "Rejected"}</ToneBadge>
          )}
        </div>
      )
    case "step":
      return (
        <Row icon={ICON[item.icon]} tone={item.tone} ts={item.ts}>
          <p className={cn((item.icon === "committed" || item.icon === "rollback" || item.icon === "escalate") && "font-medium")}>{item.text}</p>
        </Row>
      )
    case "closed":
      return (
        <div className={cn("my-2 flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-medium", softTone(item.tone))}>
          <Dot tone={item.tone} />
          {titleCase(item.status)}
        </div>
      )
  }
}

export function IncidentMeta({ incident }: { incident: Incident }) {
  const elapsed = useElapsed(incident)
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {incident.usage && <span className="font-mono">{incident.usage.tool_calls} tools · ${incident.usage.cost_usd.toFixed(4)}</span>}
      {elapsed != null && <span className="font-mono tabular-nums text-foreground">{fmtDur(elapsed)}</span>}
    </div>
  )
}
