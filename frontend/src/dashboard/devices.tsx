import { Cell, Column, Row, TableBody, TableHeader, TableView } from "@react-spectrum/s2"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import { StatusText, ToneBadge } from "@/components/status"
import type { Netmedic } from "@/lib/use-netmedic"

import { Loading } from "./overview"

export function DevicesPage({ nm, onDevice }: { nm: Netmedic; onDevice: (name: string) => void }) {
  if (!nm.net) return <Loading />
  const m = nm.net
  return (
    <TableView aria-label="Devices" onAction={(k) => onDevice(String(k))} styles={style({ height: "[calc(100vh - 160px)]", minHeight: 320 })}>
      <TableHeader>
        <Column isRowHeader>Name</Column>
        <Column>Status</Column>
        <Column>Role</Column>
        <Column>ASN</Column>
        <Column>Loopback</Column>
        <Column align="end">Sessions</Column>
        <Column align="end">Issues</Column>
      </TableHeader>
      <TableBody>
        {m.devices.map((d) => (
          <Row key={d.name} id={d.name}>
            <Cell>{d.name}</Cell>
            <Cell><StatusText status={d.status} /></Cell>
            <Cell>{d.role ? d.role[0].toUpperCase() + d.role.slice(1) : "–"}</Cell>
            <Cell>{d.asn != null ? `AS${d.asn}` : "–"}</Cell>
            <Cell>{d.loopback ?? "–"}</Cell>
            <Cell align="end">{d.up}/{d.total}</Cell>
            <Cell align="end">{d.issues.length ? <ToneBadge tone="warn">{d.issues.length}</ToneBadge> : "–"}</Cell>
          </Row>
        ))}
      </TableBody>
    </TableView>
  )
}
