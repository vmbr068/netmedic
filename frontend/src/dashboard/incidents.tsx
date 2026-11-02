import { useEffect, useState } from "react"
import { marked } from "marked"
import { ActionButton, Content, IllustratedMessage, Heading, ListView, ListViewItem, Skeleton, Text } from "@react-spectrum/s2"
import ChevronLeft from "@react-spectrum/s2/icons/ChevronLeft"
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight"
import FileText from "@react-spectrum/s2/illustrations/linear/FileText"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import { Panel } from "@/components/panel"
import { api, fmtDur, reportTime, titleCase } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"

// Reports are written by netmedic itself, but quote router output: escape before rendering Markdown.
const PAGE_SIZE = 10

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export function IncidentsPage({ nm, report, onReport }: { nm: Netmedic; report: string; onReport: (name: string) => void }) {
  const [html, setHtml] = useState<string | null>(null)
  const current = report || nm.reports[0]?.name
  const pages = Math.max(1, Math.ceil(nm.reports.length / PAGE_SIZE))
  const [page, setPage] = useState(0)
  // A report opened by link (#incidents/<name>) shows the page that holds it.
  useEffect(() => {
    const i = nm.reports.findIndex((r) => r.name === report)
    if (i >= 0) setPage(Math.floor(i / PAGE_SIZE))
  }, [report, nm.reports])
  const shown = nm.reports.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  useEffect(() => {
    if (!current) return
    setHtml(null)
    api.report(current).then((text) => setHtml(marked.parse(escape(text), { async: false })))
  }, [current])

  if (!nm.reports.length) {
    return (
      <IllustratedMessage styles={style({ marginY: 64, marginX: "auto" })}>
        <FileText />
        <Heading>No incident yet</Heading>
        <Content>Reports appear here once netmedic handles an incident.</Content>
      </IllustratedMessage>
    )
  }

  return (
    <div className={style({ display: "grid", gap: 16, alignItems: "start", gridTemplateColumns: { default: ["1fr"], lg: [400, "1fr"] } })}>
      <div className={style({ display: "flex", flexDirection: "column", gap: 8 })}>
        <ListView aria-label="Incidents" selectionMode="single" selectionStyle="highlight" disallowEmptySelection
                  selectedKeys={current ? [current] : []} onSelectionChange={(keys) => { const [k] = keys; if (k) onReport(String(k)) }}
                  styles={style({ height: "auto" })}>
          {shown.map((r) => {
            const t = reportTime(r.name)
            const when = t?.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
            return (
              <ListViewItem key={r.name} id={r.name} textValue={r.summary}>
                <Text>{r.summary}</Text>
                <Text slot="description">{titleCase(r.status)} · {when}{r.duration != null && ` · ${fmtDur(r.duration)}`}</Text>
              </ListViewItem>
            )
          })}
        </ListView>
        <nav aria-label="Incident pages" className={style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 })}>
          <ActionButton isQuiet aria-label="Previous page" isDisabled={page === 0} onPress={() => setPage(page - 1)}><ChevronLeft /></ActionButton>
          <span className={style({ font: "ui-sm", color: "neutral-subdued" })}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, nm.reports.length)} of {nm.reports.length}
          </span>
          <ActionButton isQuiet aria-label="Next page" isDisabled={page >= pages - 1} onPress={() => setPage(page + 1)}><ChevronRight /></ActionButton>
        </nav>
      </div>
      <Panel>
        <div className={style({ padding: 24 })}>
          {html == null
            ? <Skeleton isLoading><p className={style({ font: "heading" })}>Loading report</p><p className={style({ font: "body" })}>Loading the incident report content</p></Skeleton>
            : <article className={"report " + style({ font: "body-sm" })} dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      </Panel>
    </div>
  )
}
