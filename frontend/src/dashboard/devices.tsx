import { StatusText, ToneBadge } from "@/components/status"
import { Panel } from "@/components/panel"
import { CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { model } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"

import { Loading } from "./overview"

export function DevicesPage({ nm, onDevice }: { nm: Netmedic; onDevice: (name: string) => void }) {
  if (!nm.snapshot) return <Loading />
  const m = model(nm.snapshot)
  return (
    <Panel cardClassName="py-0">
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>ASN</TableHead>
              <TableHead>Loopback</TableHead>
              <TableHead className="text-right">Sessions</TableHead>
              <TableHead className="pr-6 text-right">Issues</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {m.devices.map((d, i) => (
              <TableRow key={d.name} className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-300 cursor-pointer" style={{ animationDelay: `${i * 40}ms` }}
                        onClick={() => onDevice(d.name)}>
                <TableCell className="pl-6 font-medium">{d.name}</TableCell>
                <TableCell><StatusText status={d.status} /></TableCell>
                <TableCell className="capitalize text-muted-foreground">{d.role ?? "–"}</TableCell>
                <TableCell className="tabular-nums">{d.asn != null ? `AS${d.asn}` : "–"}</TableCell>
                <TableCell className="font-mono text-xs">{d.loopback ?? "–"}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{d.up}/{d.total}</TableCell>
                <TableCell className="pr-6 text-right">
                  {d.issues.length ? <ToneBadge tone="warn">{d.issues.length}</ToneBadge> : <span className="text-muted-foreground">–</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Panel>
  )
}
