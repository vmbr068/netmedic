import { ActionButton, Cell, Column, Content, IllustratedMessage, Heading, Row, Skeleton, TableBody, TableHeader, TableView } from "@react-spectrum/s2"
import Check from "@react-spectrum/s2/illustrations/linear/Check"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import { IncidentFeed, IncidentMeta, Stepper } from "@/components/incident-feed"
import { Panel, PanelHeader, panelBody } from "@/components/panel"
import { StatusText, ToneBadge, ToneLight } from "@/components/status"
import { Topology } from "@/components/topology"
import { fmtDur, model, reportTime, reportTone, titleCase, type Model } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"

import type { Go } from "./app"


export function OverviewPage({ nm, onDevice, go }: { nm: Netmedic; onDevice: (name: string) => void; go: Go }) {
  if (!nm.snapshot) return <Loading />
  const s = nm.snapshot, m = model(s)
  const day = nm.reports.filter((r) => Date.now() - (reportTime(r.name)?.getTime() ?? 0) < 86_400_000)
  const handled = day.filter((r) => reportTone(r.status) !== "bad")
  const timed = handled.filter((r) => r.duration != null)

  return (
    <div className={style({ display: "flex", flexDirection: "column", gap: 16 })}>
      <div className={style({ display: "grid", gap: 16, gridTemplateColumns: { default: ["1fr", "1fr"], xl: ["1fr", "1fr", "1fr", "1fr"] } })}>
        <Kpi title="Health" value={m.score} unit="%"><Sparkline values={nm.health} /></Kpi>
        <Kpi title="Devices" value={m.online} unit={`/ ${m.devices.length}`}>
          <Segments parts={[
            [m.devices.filter((d) => d.status === "ok").length, "ok"],
            [m.devices.filter((d) => d.status === "warn").length, "warn"],
            [m.devices.filter((d) => d.status === "bad").length, "bad"],
          ]} />
        </Kpi>
        <Kpi title="Sessions" value={m.sessUp} unit={`/ ${m.sessTotal}`}>
          <Segments parts={[[m.sessUp, "ok"], [m.sessTotal - m.sessUp, "bad"]]} />
        </Kpi>
        <Kpi title="Incidents · 24h" value={day.length}>
          <div className={style({ display: "flex", gap: 16, font: "ui-sm", color: "neutral-subdued" })}>
            <span>MTTR <b className={style({ color: "neutral" })}>{timed.length ? fmtDur(timed.reduce((a, r) => a + r.duration!, 0) / timed.length) : "–"}</b></span>
            <span>Handled <b className={style({ color: "neutral" })}>{day.length ? `${Math.round((handled.length / day.length) * 100)}%` : "–"}</b></span>
          </div>
        </Kpi>
      </div>

      <div className={style({ display: "grid", gap: 16, gridTemplateColumns: { default: ["1fr"], xl: ["3fr", "2fr"] } })}>
        <Panel>
          <PanelHeader title="Topology" description={`${m.links.filter((l) => l.up).length}/${m.links.length} links up`}
                       actions={<ActionButton isQuiet onPress={() => go("topology")}>Open</ActionButton>} />
          <div className={panelBody}><Topology m={m} snapshot={s} height={440} onSelect={onDevice} /></div>
        </Panel>

        <Panel>
          <PanelHeader title={<>Live incident{nm.incident.active && <ToneBadge tone="bad">Live</ToneBadge>}</>}
                       actions={<IncidentMeta incident={nm.incident} />} />
          <div className={panelBody}>
            {nm.incident.feed.length ? (
              <>
                <Stepper incident={nm.incident} />
                <IncidentFeed incident={nm.incident} height={400} />
              </>
            ) : <Quiet m={m} />}
          </div>
        </Panel>
      </div>

      <div className={style({ display: "grid", gap: 16, gridTemplateColumns: { default: ["1fr"], xl: ["1fr", "1fr"] } })}>
        <Panel>
          <PanelHeader title="Devices" actions={<ActionButton isQuiet onPress={() => go("devices")}>View all</ActionButton>} />
          <div className={panelBody}>
            <TableView aria-label="Devices" isQuiet density="compact" onAction={(k) => onDevice(String(k))} styles={style({ height: "auto" })}>
              <TableHeader>
                <Column isRowHeader>Name</Column>
                <Column>Status</Column>
                <Column align="end">Sessions</Column>
              </TableHeader>
              <TableBody>
                {m.devices.map((d) => (
                  <Row key={d.name} id={d.name}>
                    <Cell>{d.name}</Cell>
                    <Cell><StatusText status={d.status} /></Cell>
                    <Cell align="end">{d.up}/{d.total}</Cell>
                  </Row>
                ))}
              </TableBody>
            </TableView>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Recent incidents" actions={<ActionButton isQuiet onPress={() => go("incidents")}>View all</ActionButton>} />
          <div className={panelBody}>
            <TableView aria-label="Recent incidents" isQuiet density="compact" overflowMode="truncate"
                       onAction={(k) => go("incidents", String(k))} styles={style({ height: "auto" })}>
              <TableHeader>
                <Column width={80}>Time</Column>
                <Column isRowHeader>Summary</Column>
                <Column width={190}>Status</Column>
              </TableHeader>
              <TableBody renderEmptyState={() => <IllustratedMessage size="S"><Heading>No incident yet</Heading></IllustratedMessage>}>
                {nm.reports.slice(0, 6).map((r) => (
                  <Row key={r.name} id={r.name}>
                    <Cell>{reportTime(r.name)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</Cell>
                    <Cell>{r.summary}</Cell>
                    <Cell><ToneLight tone={reportTone(r.status)}>{titleCase(r.status)}</ToneLight></Cell>
                  </Row>
                ))}
              </TableBody>
            </TableView>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Quiet({ m }: { m: Model }) {
  const issues = m.devices.flatMap((d) => d.issues)
  if (issues.length) {
    return (
      <ul className={style({ display: "flex", flexDirection: "column", padding: 0, margin: 0, listStyleType: "none", font: "body-sm" })}>
        {issues.map((x) => (
          <li key={x.text} className={style({ display: "flex", alignItems: "center", gap: 8, paddingY: 8, borderWidth: 0, borderBottomWidth: 1, borderStyle: "solid", borderColor: "gray-200" })}>
            <ToneBadge tone={x.acknowledged ? "warn" : "bad"}>{x.kind.toUpperCase()}</ToneBadge>
            <span className={style({ flexGrow: 1, minWidth: 0, truncate: true })}>{x.text}</span>
            {x.acknowledged && <ToneBadge tone="warn">Escalated</ToneBadge>}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className={style({ height: 440, display: "flex", alignItems: "center", justifyContent: "center" })}>
      <IllustratedMessage>
        <Check />
        <Heading>No active incident</Heading>
        <Content>netmedic is watching the network.</Content>
      </IllustratedMessage>
    </div>
  )
}

function Kpi({ title, value, unit, children }: { title: string; value: number; unit?: string; children: React.ReactNode }) {
  return (
    <Panel>
      <div className={style({ padding: 20, display: "flex", flexDirection: "column", gap: 12, height: "full" })}>
        <span className={style({ font: "detail", color: "neutral-subdued" })}>{title}</span>
        <p className={style({ margin: 0, display: "flex", alignItems: "baseline", gap: 8 })}>
          <span className={style({ font: "heading-2xl" })}>{value}</span>
          {unit && <span className={style({ font: "body", color: "neutral-subdued" })}>{unit}</span>}
        </p>
        <div className={style({ marginTop: "auto" })}>{children}</div>
      </div>
    </Panel>
  )
}

const SEG = {
  ok: style({ backgroundColor: "positive-900", height: "full", borderRadius: "full", transition: "default" }),
  warn: style({ backgroundColor: "notice-800", height: "full", borderRadius: "full", transition: "default" }),
  bad: style({ backgroundColor: "negative-900", height: "full", borderRadius: "full", transition: "default" }),
}

function Segments({ parts }: { parts: [number, keyof typeof SEG][] }) {
  const total = parts.reduce((a, [v]) => a + v, 0) || 1
  return (
    <div className={style({ display: "flex", gap: 2, height: 8, overflow: "hidden", borderRadius: "full", backgroundColor: "gray-200" })}>
      {parts.map(([v, tone], i) => v > 0 && <span key={i} className={SEG[tone]} style={{ width: `${(v / total) * 100}%` }} />)}
    </div>
  )
}

// Health over the last minutes.
function Sparkline({ values }: { values: number[] }) {
  const v = values.length >= 2 ? values : [values[0] ?? 100, values[0] ?? 100]
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 200, 26 - (x / 100) * 22])
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("")
  return (
    <svg viewBox="0 0 200 28" preserveAspectRatio="none" className={style({ width: "full", height: 32, overflow: "visible", display: "block" })}>
      <path d={`${line}L200,28L0,28Z`} className={style({ fill: "accent-900" })} fillOpacity={0.12} />
      <path d={line} fill="none" className={style({ stroke: "accent-900" })} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  )
}

export function Loading() {
  return (
    <Skeleton isLoading>
      <div className={style({ display: "grid", gap: 16, gridTemplateColumns: { default: ["1fr", "1fr"], xl: ["1fr", "1fr", "1fr", "1fr"] } })}>
        {[0, 1, 2, 3].map((i) => <Panel key={i}><div className={style({ height: 128 })} /></Panel>)}
      </div>
    </Skeleton>
  )
}
