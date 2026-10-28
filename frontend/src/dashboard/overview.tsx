import { motion } from "motion/react"
import { Activity, CircleCheck, Cable, Server, ShieldAlert } from "lucide-react"

import { IncidentFeed, IncidentMeta, Stepper } from "@/components/incident-feed"
import { StatusText, ToneBadge } from "@/components/status"
import { Topology } from "@/components/topology"
import { Panel } from "@/components/panel"
import { Reveal } from "@/components/reveal"
import { Button } from "@/components/ui/button"
import { CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DotPattern } from "@/components/ui/dot-pattern"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fmtDur, model, reportTime, reportTone, titleCase, type Model } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"
import { cn } from "@/lib/utils"

import type { Go } from "./app"

export function OverviewPage({ nm, onDevice, go }: { nm: Netmedic; onDevice: (name: string) => void; go: Go }) {
  if (!nm.snapshot) return <Loading />
  const s = nm.snapshot, m = model(s)
  const day = nm.reports.filter((r) => Date.now() - (reportTime(r.name)?.getTime() ?? 0) < 86_400_000)
  const handled = day.filter((r) => reportTone(r.status) !== "bad")
  const timed = handled.filter((r) => r.duration != null)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi i={0} icon={Activity} title="Health" value={m.score} unit="%">
          <Sparkline values={nm.health} />
        </Kpi>
        <Kpi i={1} icon={Server} title="Devices" value={m.online} unit={`/ ${m.devices.length}`}>
          <Segments parts={[
            [m.devices.filter((d) => d.status === "ok").length, "bg-success"],
            [m.devices.filter((d) => d.status === "warn").length, "bg-warning"],
            [m.devices.filter((d) => d.status === "bad").length, "bg-destructive"],
          ]} />
        </Kpi>
        <Kpi i={2} icon={Cable} title="Sessions" value={m.sessUp} unit={`/ ${m.sessTotal}`}>
          <Segments parts={[[m.sessUp, "bg-info"], [m.sessTotal - m.sessUp, "bg-destructive"]]} />
        </Kpi>
        <Kpi i={3} icon={ShieldAlert} title="Incidents · 24h" value={day.length}>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>MTTR <b className="font-medium text-foreground">{timed.length ? fmtDur(timed.reduce((a, r) => a + r.duration!, 0) / timed.length) : "–"}</b></span>
            <span>Handled <b className="font-medium text-foreground">{day.length ? `${Math.round((handled.length / day.length) * 100)}%` : "–"}</b></span>
          </div>
        </Kpi>
      </div>

      <Reveal delay={0.2} className="grid gap-4 xl:grid-cols-5">
        <Panel className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Topology</CardTitle>
            <CardDescription>{m.links.filter((l) => l.up).length}/{m.links.length} links up</CardDescription>
            <CardAction><Button variant="ghost" size="sm" onClick={() => go("topology")}>Open</Button></CardAction>
          </CardHeader>
          <CardContent className="relative">
            <DotPattern width={18} height={18} className="text-foreground/15 [mask-image:radial-gradient(ellipse_at_center,white,transparent_75%)]" />
            <Topology m={m} snapshot={s} height={440} onSelect={onDevice} className="relative" />
          </CardContent>
        </Panel>

        <Panel className="xl:col-span-2" beam={nm.incident.active}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Live incident{nm.incident.active && <LiveBadge />}</CardTitle>
            <CardAction><IncidentMeta incident={nm.incident} /></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {nm.incident.feed.length ? (
              <>
                <Stepper incident={nm.incident} />
                <IncidentFeed incident={nm.incident} className="h-[400px] -mr-2 pr-2" />
              </>
            ) : <Quiet m={m} />}
          </CardContent>
        </Panel>
      </Reveal>

      <Reveal delay={0.3} className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <CardHeader>
            <CardTitle>Devices</CardTitle>
            <CardAction><Button variant="ghost" size="sm" onClick={() => go("devices")}>View all</Button></CardAction>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Sessions</TableHead></TableRow></TableHeader>
              <TableBody>
                {m.devices.map((d) => (
                  <TableRow key={d.name} className="cursor-pointer" onClick={() => onDevice(d.name)}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell><StatusText status={d.status} /></TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{d.up}/{d.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Panel>

        <Panel>
          <CardHeader>
            <CardTitle>Recent incidents</CardTitle>
            <CardAction><Button variant="ghost" size="sm" onClick={() => go("incidents")}>View all</Button></CardAction>
          </CardHeader>
          <CardContent>
            {nm.reports.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Summary</TableHead><TableHead className="text-right">Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {nm.reports.slice(0, 6).map((r) => (
                    <TableRow key={r.name} className="cursor-pointer" onClick={() => go("incidents", r.name)}>
                      <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                        {reportTime(r.name)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                      </TableCell>
                      <TableCell className="max-w-0 truncate">{r.summary}</TableCell>
                      <TableCell className="text-right"><ToneBadge tone={reportTone(r.status)}>{titleCase(r.status)}</ToneBadge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <p className="py-6 text-center text-sm text-muted-foreground">No incident yet</p>}
          </CardContent>
        </Panel>
      </Reveal>
    </div>
  )
}

function Quiet({ m }: { m: Model }) {
  const issues = m.devices.flatMap((d) => d.issues)
  if (issues.length) {
    return (
      <ul className="flex flex-col divide-y text-sm">
        {issues.map((x) => (
          <li key={x.text} className="flex items-center gap-2 py-2">
            <ToneBadge tone={x.acknowledged ? "warn" : "bad"} className="uppercase">{x.kind}</ToneBadge>
            <span className="min-w-0 flex-1 truncate">{x.text}</span>
            {x.acknowledged && <ToneBadge tone="warn">Escalated</ToneBadge>}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="flex h-[440px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <CircleCheck className="size-8 text-success" strokeWidth={1.5} />
      No active incident
    </div>
  )
}

function Kpi({ i, icon: Icon, title, value, unit, children }: {
  i: number; icon: typeof Activity; title: string; value: number; unit?: string; children: React.ReactNode
}) {
  return (
    <Reveal delay={i * 0.06} className="h-full">
      <Panel className="h-full">
        <CardHeader>
          <CardDescription className="font-medium">{title}</CardDescription>
          <CardAction><span className="grid size-8 place-items-center rounded-full bg-primary/10 text-primary"><Icon className="size-4" /></span></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-4xl font-semibold tracking-tight tabular-nums">
            <NumberTicker value={value} startValue={value} className="tracking-tight text-foreground" />
            {unit && <span className="ml-1.5 text-base font-normal text-muted-foreground">{unit}</span>}
          </p>
          {children}
        </CardContent>
      </Panel>
    </Reveal>
  )
}

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-destructive">
      <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" /><span className="relative size-1.5 rounded-full bg-destructive" /></span>
      LIVE
    </span>
  )
}

function Segments({ parts }: { parts: [number, string][] }) {
  const total = parts.reduce((a, [v]) => a + v, 0) || 1
  return (
    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted">
      {parts.map(([v, c], i) => v > 0 && (
        <motion.span key={i} className={cn("h-full rounded-full", c)} initial={{ width: 0 }}
                     animate={{ width: `${(v / total) * 100}%` }} transition={{ type: "spring", stiffness: 120, damping: 20, delay: 0.15 }} />
      ))}
    </div>
  )
}

// Health over the last minutes; the line draws itself in, then follows new points.
function Sparkline({ values }: { values: number[] }) {
  const v = values.length >= 2 ? values : [values[0] ?? 100, values[0] ?? 100]
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 200, 26 - (x / 100) * 22])
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("")
  return (
    <svg viewBox="0 0 200 28" preserveAspectRatio="none" className="h-8 w-full overflow-visible">
      <defs>
        <linearGradient id="spark" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <motion.path d={`${line}L200,28L0,28Z`} fill="url(#spark)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} />
      <motion.path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round"
                   initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: "easeOut" }} />
    </svg>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
      <Skeleton className="h-[480px] rounded-xl" />
    </div>
  )
}

export { Loading }
