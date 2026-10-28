import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Status } from "@/lib/api"
import type { Tone } from "@/lib/incident"

const DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", info: "bg-info" }
const SOFT: Record<Tone, string> = {
  ok: "bg-success/10 text-success",
  warn: "bg-warning/15 text-[color-mix(in_oklch,var(--warning),black_25%)] dark:text-warning",
  bad: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
}
export const STATUS_LABEL: Record<Status, string> = { ok: "Online", warn: "Degraded", bad: "Offline" }

export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT[tone])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
    </span>
  )
}

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <Badge className={cn("border-0 font-medium", SOFT[tone], className)}>{children}</Badge>
}

export function StatusText({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Dot tone={status} />
      {STATUS_LABEL[status]}
    </span>
  )
}

export const softTone = (tone: Tone) => SOFT[tone]
