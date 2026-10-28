import { useEffect, useState } from "react"
import { FileText } from "lucide-react"
import { marked } from "marked"

import { ToneBadge } from "@/components/status"
import { Panel } from "@/components/panel"
import { CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api, fmtDur, reportTime, reportTone, titleCase } from "@/lib/api"
import type { Netmedic } from "@/lib/use-netmedic"
import { cn } from "@/lib/utils"

// Reports are written by netmedic itself, but quote router output: escape before rendering Markdown.
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export function IncidentsPage({ nm, report, onReport }: { nm: Netmedic; report: string; onReport: (name: string) => void }) {
  const [html, setHtml] = useState<string | null>(null)
  const current = report || nm.reports[0]?.name

  const { loadReports } = nm
  useEffect(() => { loadReports() }, [loadReports])
  useEffect(() => {
    if (!current) return
    setHtml(null)
    api.report(current).then((text) => setHtml(marked.parse(escape(text), { async: false })))
  }, [current])

  if (!nm.reports.length) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <FileText className="size-8" strokeWidth={1.5} />
        No incident yet
      </div>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <Panel className="self-start lg:sticky lg:top-20" cardClassName="max-h-[calc(100vh-7rem)] gap-0 overflow-y-auto py-2">
        {nm.reports.map((r, i) => {
          const t = reportTime(r.name)
          return (
            <button key={r.name} onClick={() => onReport(r.name)} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
              className={cn("animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-300 mx-2 flex flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted",
                r.name === current && "bg-muted")}>
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {t?.toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                  {r.duration != null && ` · ${fmtDur(r.duration)}`}
                </span>
                <ToneBadge tone={reportTone(r.status)}>{titleCase(r.status)}</ToneBadge>
              </span>
              <span className="line-clamp-2 text-sm">{r.summary}</span>
            </button>
          )
        })}
      </Panel>
      <Panel>
        <CardContent>
          {html == null
            ? <div className="flex flex-col gap-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>
            : <article className="report" dangerouslySetInnerHTML={{ __html: html }} />}
        </CardContent>
      </Panel>
    </div>
  )
}
