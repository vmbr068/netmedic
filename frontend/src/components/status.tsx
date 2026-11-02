import { Badge, StatusLight } from "@react-spectrum/s2"

import type { Status } from "@/lib/api"
import type { Tone } from "@/lib/incident"

// Netmedic tones mapped onto Spectrum semantic colors.
export const VARIANT = { ok: "positive", warn: "notice", bad: "negative", info: "informative" } as const satisfies Record<Tone, string>
export const STATUS_LABEL: Record<Status, string> = { ok: "Online", warn: "Degraded", bad: "Offline" }

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <Badge size="S" variant={VARIANT[tone]}>{children}</Badge>
}

export function StatusText({ status }: { status: Status }) {
  return <StatusLight variant={VARIANT[status]}>{STATUS_LABEL[status]}</StatusLight>
}

export function ToneLight({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <StatusLight variant={VARIANT[tone]}>{children}</StatusLight>
}
