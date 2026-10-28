import { StatusText, ToneBadge } from "@/components/status"
import { Topology } from "@/components/topology"
import { Panel } from "@/components/panel"
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { model, type Device } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"

import { Loading } from "./overview"

export function TopologyPage({ nm, selected, onSelect }: { nm: Netmedic; selected: string; onSelect: (name: string) => void }) {
  if (!nm.snapshot) return <Loading />
  const s = nm.snapshot, m = model(s)
  const device = m.devices.find((d) => d.name === selected) ?? m.devices[0]

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <Panel>
        <CardHeader>
          <CardTitle>{m.devices.length} devices</CardTitle>
          <CardDescription>{m.links.filter((l) => l.up).length}/{m.links.length} links up · {m.externals.length} external peers</CardDescription>
        </CardHeader>
        <CardContent>
          <Topology m={m} snapshot={s} height={600} selected={device?.name} onSelect={onSelect} />
        </CardContent>
      </Panel>
      {device && <DeviceDetail d={device} sessions={s.sessions[device.name] || {}} />}
    </div>
  )
}

function DeviceDetail({ d, sessions }: { d: Device; sessions: Record<string, string> }) {
  const rows: [string, React.ReactNode][] = [
    ["Status", <StatusText status={d.status} />],
    ["Role", d.role ? <span className="capitalize">{d.role}</span> : "–"],
    ["ASN", d.asn != null ? `AS${d.asn}` : "–"],
    ["Loopback", <span className="font-mono text-xs">{d.loopback ?? "–"}</span>],
    ["Sessions", `${d.up}/${d.total}`],
  ]
  return (
    <Panel className="self-start">
      <CardHeader>
        <CardTitle>{d.name}</CardTitle>
        <CardDescription>BIRD · Linux</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-[96px_1fr] gap-y-2.5">
          {rows.map(([k, v]) => [<dt key={k} className="text-muted-foreground">{k}</dt>, <dd key={k + "v"}>{v}</dd>])}
        </dl>
        <Separator />
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Protocols</p>
          {Object.entries(sessions).map(([proto, state]) => (
            <div key={proto} className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{proto}</span>
              <ToneBadge tone={state.startsWith("Established") ? "ok" : "bad"}>{state.split(" ")[0]}</ToneBadge>
            </div>
          ))}
          {!Object.keys(sessions).length && <p className="text-muted-foreground">–</p>}
        </div>
        {d.issues.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">Issues</p>
              {d.issues.map((x) => (
                <div key={x.text} className="flex items-start gap-2">
                  <ToneBadge tone={x.acknowledged ? "warn" : "bad"} className="uppercase">{x.kind}</ToneBadge>
                  <span>{x.text.slice(d.name.length + 2)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Panel>
  )
}
