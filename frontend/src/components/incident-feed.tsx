import { useEffect, useRef, useState } from "react"
import {
  Button, ButtonGroup, Content, Disclosure, DisclosurePanel, DisclosureTitle, Heading, InlineAlert, ProgressCircle,
} from "@react-spectrum/s2"
import AIMark from "@react-spectrum/s2/icons/AIMark"
import AlertTriangle from "@react-spectrum/s2/icons/AlertTriangle"
import Checkmark from "@react-spectrum/s2/icons/Checkmark"
import CheckmarkCircle from "@react-spectrum/s2/icons/CheckmarkCircle"
import Close from "@react-spectrum/s2/icons/Close"
import Code from "@react-spectrum/s2/icons/Code"
import Hand from "@react-spectrum/s2/icons/Hand"
import Lightbulb from "@react-spectrum/s2/icons/Lightbulb"
import Tools from "@react-spectrum/s2/icons/Tools"
import Undo from "@react-spectrum/s2/icons/Undo"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }

import { ToneBadge, VARIANT } from "@/components/status"
import { api, fmtDur, hhmmss, titleCase } from "@/lib/api"
import { STAGES, type FeedItem, type Incident, type StepIcon, type Tone } from "@/lib/incident"

const RISK: Record<string, Tone> = { low: "ok", medium: "warn", high: "bad" }
const ICON: Record<StepIcon, typeof Checkmark> = {
  decision: Hand, action: Tools, pass: Checkmark, fail: Close, committed: CheckmarkCircle, rollback: Undo, error: AlertTriangle, escalate: AlertTriangle,
}
const ICON_STYLE = {
  ok: iconStyle({ size: "S", color: "positive" }),
  warn: iconStyle({ size: "S", color: "notice" }),
  bad: iconStyle({ size: "S", color: "negative" }),
  info: iconStyle({ size: "S", color: "informative" }),
}
const BAR = {
  done: style({ backgroundColor: "positive-900" }),
  current: style({ backgroundColor: "accent-900" }),
  failed: style({ backgroundColor: "negative-900" }),
  todo: style({ backgroundColor: "gray-200" }),
}
const pre = style({ font: "code-xs", backgroundColor: "gray-75", borderRadius: "default", padding: 8, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", maxHeight: 224 })

export function Stepper({ incident }: { incident: Incident }) {
  return (
    <ol className={style({ display: "flex", gap: 4, padding: 0, margin: 0, listStyleType: "none" })}>
      {STAGES.map((label, i) => {
        const done = i < incident.stage || (i === incident.stage && !incident.active)
        const current = i === incident.stage && incident.active
        const failed = incident.failed && i === Math.min(incident.stage, STAGES.length - 1)
        return (
          <li key={label} className={style({ display: "flex", flexDirection: "column", gap: 4, flexGrow: 1, flexBasis: 0, minWidth: 0 })}>
            <span className={style({ height: 4, borderRadius: "full", backgroundColor: "gray-200", overflow: "hidden", display: "block" })}>
              <span className={(failed ? BAR.failed : done ? BAR.done : current ? BAR.current : BAR.todo) + " " + style({ display: "block", height: "full", borderRadius: "full", transition: "default" })}
                    style={{ width: failed || done ? "100%" : current ? "55%" : "0%" }} />
            </span>
            <span className={style({ font: "ui-xs", color: { default: "neutral-subdued" }, truncate: true })}
                  style={done || current ? { color: "inherit" } : undefined}>{label}</span>
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

export function IncidentFeed({ incident, height }: { incident: Incident; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [incident.feed])

  return (
    <div ref={ref} className={style({ overflowY: "auto", marginEnd: -8, paddingEnd: 8 })} style={{ height }}
         onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      <div className={style({ display: "flex", flexDirection: "column", gap: 4 })}>
        {incident.feed.map((item, i) => <Item key={i} item={item} />)}
      </div>
    </div>
  )
}

function Row({ icon: Icon, tone = "info", ts, children }: { icon: typeof Checkmark; tone?: Tone; ts: number; children: React.ReactNode }) {
  return (
    <div className={style({ display: "flex", gap: 12, paddingY: 4 })}>
      <span className={style({ paddingTop: 2 })}><Icon styles={ICON_STYLE[tone]} /></span>
      <div className={style({ font: "body-sm", flexGrow: 1, minWidth: 0 })}>{children}</div>
      <time className={style({ font: "code-xs", color: "neutral-subdued", flexShrink: 0, paddingTop: 2 })}>{hhmmss(ts)}</time>
    </div>
  )
}

const muted = style({ color: "neutral-subdued", margin: 0, whiteSpace: "pre-wrap" })
const strong = style({ fontWeight: "bold", margin: 0 })

function Item({ item }: { item: FeedItem }) {
  switch (item.type) {
    case "opened":
      return (
        <Row icon={AlertTriangle} tone="bad" ts={item.ts}>
          <p className={strong}>Incident detected</p>
          <p className={muted}>{item.text}</p>
        </Row>
      )
    case "model":
      return <Row icon={AIMark} ts={item.ts}><span className={style({ font: "code-xs" })}>{item.text}</span></Row>
    case "think":
      return <Row icon={Lightbulb} ts={item.ts}><p className={muted}>{item.text}</p></Row>
    case "tool":
      return (
        <Row icon={Code} ts={item.ts}>
          <Disclosure isQuiet size="S" styles={style({ marginTop: -4 })}>
            <DisclosureTitle>
              <span className={style({ font: "code-xs", truncate: true })}>{item.name}({item.args})</span>
              {item.output == null && <ProgressCircle size="S" isIndeterminate aria-label="Running" styles={style({ marginStart: 8 })} />}
            </DisclosureTitle>
            <DisclosurePanel><pre className={pre}>{item.output ?? ""}</pre></DisclosurePanel>
          </Disclosure>
        </Row>
      )
    case "diagnosis":
      return (
        <div className={style({ marginY: 8, padding: 16, borderRadius: "lg", borderWidth: 1, borderStyle: "solid", borderColor: "gray-200", backgroundColor: "layer-1", font: "body-sm" })}>
          <p className={strong}>{item.dx.summary}</p>
          <p className={muted}>{item.dx.root_cause}</p>
          {item.dx.plan.length > 0 && (
            <ol className={style({ display: "flex", flexDirection: "column", gap: 12, padding: 0, marginTop: 12, marginBottom: 0, listStyleType: "none" })}>
              {item.dx.plan.map((step, i) => (
                <li key={i} className={style({ display: "flex", gap: 8 })}>
                  <span className={style({ font: "ui-xs", fontWeight: "bold", color: "white", backgroundColor: "gray-800", borderRadius: "full", size: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" })}>{i + 1}</span>
                  <div className={style({ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 })}>
                    <div className={style({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 })}>
                      <span className={strong}>{step.title}</span>
                      <ToneBadge tone={RISK[step.risk] ?? "warn"}>{step.risk} risk</ToneBadge>
                    </div>
                    <pre className={pre}>{step.actions.map((a) => JSON.stringify(a)).join("\n")}</pre>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )
    case "approval":
      return (
        <InlineAlert variant="notice" styles={style({ marginY: 8 })}>
          <Heading>{item.remediation.title} · {item.remediation.risk} risk</Heading>
          <Content>
            <p className={style({ margin: 0 })}>{item.remediation.description}</p>
            {item.approved == null ? (
              <ButtonGroup styles={style({ marginTop: 12 })}>
                <Button size="S" variant="accent" onPress={() => api.approve(item.id, true)}>Approve</Button>
                <Button size="S" variant="secondary" onPress={() => api.approve(item.id, false)}>Reject</Button>
              </ButtonGroup>
            ) : (
              <div className={style({ marginTop: 12 })}><ToneBadge tone={item.approved ? "ok" : "bad"}>{item.approved ? "Approved" : "Rejected"}</ToneBadge></div>
            )}
          </Content>
        </InlineAlert>
      )
    case "step": {
      const bold = item.icon === "committed" || item.icon === "rollback" || item.icon === "escalate"
      return <Row icon={ICON[item.icon]} tone={item.tone} ts={item.ts}><p className={bold ? strong : style({ margin: 0 })}>{item.text}</p></Row>
    }
    case "closed":
      return (
        <InlineAlert variant={VARIANT[item.tone]} styles={style({ marginY: 8 })}>
          <Heading>{titleCase(item.status)}</Heading>
        </InlineAlert>
      )
  }
}

export function IncidentMeta({ incident }: { incident: Incident }) {
  const elapsed = useElapsed(incident)
  return (
    <div className={style({ display: "flex", alignItems: "center", gap: 12, font: "code-xs", color: "neutral-subdued" })}>
      {incident.usage && <span>{incident.usage.tool_calls} tools · ${incident.usage.cost_usd.toFixed(4)}</span>}
      {elapsed != null && <span className={style({ color: "neutral" })}>{fmtDur(elapsed)}</span>}
    </div>
  )
}
