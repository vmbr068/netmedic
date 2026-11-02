import { Divider } from "@react-spectrum/s2"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import { Panel, PanelHeader, panelBody } from "@/components/panel"
import { StatusText, ToneBadge } from "@/components/status"
import { Topology } from "@/components/topology"
import type { Device } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"

import { Loading } from "./overview"

export function TopologyPage({ nm, selected, onSelect }: { nm: Netmedic; selected: string; onSelect: (name: string) => void }) {
  if (!nm.snapshot || !nm.net) return <Loading />
  const s = nm.snapshot, m = nm.net
  const device = m.devices.find((d) => d.name === selected) ?? m.devices[0]

  return (
    <div className={style({ display: "grid", gap: 16, alignItems: "start", gridTemplateColumns: { default: ["1fr"], xl: ["1fr", 340] } })}>
      <Panel>
        <PanelHeader title={`${m.devices.length} devices`}
                     description={`${m.links.filter((l) => l.up).length}/${m.links.length} links up · ${m.externals.length} external peers`} />
        <div className={panelBody}><Topology m={m} snapshot={s} height={600} selected={device?.name} onSelect={onSelect} /></div>
      </Panel>
      {device && <DeviceDetail d={device} sessions={s.sessions[device.name] || {}} />}
    </div>
  )
}

const label = style({ font: "detail-sm", color: "neutral-subdued", margin: 0 })

function DeviceDetail({ d, sessions }: { d: Device; sessions: Record<string, string> }) {
  const rows: [string, React.ReactNode][] = [
    ["Status", <StatusText key="status" status={d.status} />],
    ["Role", d.role ? d.role[0].toUpperCase() + d.role.slice(1) : "–"],
    ["ASN", d.asn != null ? `AS${d.asn}` : "–"],
    ["Loopback", <span key="loopback" className={style({ font: "code-sm" })}>{d.loopback ?? "–"}</span>],
    ["Sessions", `${d.up}/${d.total}`],
  ]
  return (
    <Panel>
      <PanelHeader title={d.name} description="BIRD · Linux" />
      <div className={panelBody + " " + style({ font: "body-sm" })}>
        <dl className={style({ display: "grid", gridTemplateColumns: [96, "1fr"], rowGap: 8, margin: 0, alignItems: "center" })}>
          {rows.map(([k, v]) => [<dt key={k} className={style({ color: "neutral-subdued" })}>{k}</dt>, <dd key={k + "v"} className={style({ margin: 0 })}>{v}</dd>])}
        </dl>
        <Divider size="S" />
        <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
          <p className={label}>Protocols</p>
          {Object.entries(sessions).map(([proto, state]) => (
            <div key={proto} className={style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 })}>
              <span className={style({ font: "code-sm" })}>{proto}</span>
              <ToneBadge tone={state.startsWith("Established") ? "ok" : "bad"}>{state.split(" ")[0]}</ToneBadge>
            </div>
          ))}
          {!Object.keys(sessions).length && <p className={style({ color: "neutral-subdued", margin: 0 })}>–</p>}
        </div>
        {d.issues.length > 0 && (
          <>
            <Divider size="S" />
            <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
              <p className={label}>Issues</p>
              {d.issues.map((x) => (
                <div key={x.text} className={style({ display: "flex", alignItems: "start", gap: 8 })}>
                  <ToneBadge tone={x.acknowledged ? "warn" : "bad"}>{x.kind.toUpperCase()}</ToneBadge>
                  <span>{x.text.slice(d.name.length + 2)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  )
}
