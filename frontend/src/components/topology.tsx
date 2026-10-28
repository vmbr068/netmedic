import { useEffect, useRef, useState } from "react"
import { motion } from "motion/react"

import type { Device, Model, Snapshot } from "@/lib/api"
import { cn } from "@/lib/utils"

type Point = [number, number]

// Layered layout when the inventory gives each router a layer (edge / core / access), ring otherwise.
function layout(devices: Device[], w: number, h: number): Record<string, Point> {
  const pos: Record<string, Point> = {}
  if (devices.length && devices.every((d) => d.layer != null)) {
    const layers = [...new Set(devices.map((d) => d.layer!))].sort((a, b) => a - b)
    const top = h * 0.16, bottom = h * 0.84
    layers.forEach((layer, li) => {
      const row = devices.filter((d) => d.layer === layer)
      const y = layers.length > 1 ? top + ((bottom - top) * li) / (layers.length - 1) : h / 2
      row.forEach((d, i) => { pos[d.name] = [(w * (i + 1)) / (row.length + 1), y] })
    })
    return pos
  }
  devices.forEach((d, i) => {
    const a = -Math.PI * 0.75 + (2 * Math.PI * i) / Math.max(devices.length, 1)
    pos[d.name] = [w / 2 + w * 0.32 * Math.cos(a), h / 2 + h * 0.32 * Math.sin(a)]
  })
  return pos
}

const STROKE = { ok: "var(--border)", warn: "var(--warning)", bad: "var(--destructive)" }
const FILL = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--destructive)" }

// Drawn at the real size of its container (1 unit = 1 px), so labels stay readable at any width.
export function Topology({
  m, snapshot, height = 520, selected, onSelect, className,
}: {
  m: Model; snapshot: Snapshot; height?: number
  selected?: string | null; onSelect?: (name: string) => void; className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className={cn("w-full", className)} style={{ height }}>
      {width > 0 && <Graph m={m} snapshot={snapshot} width={width} height={height} selected={selected} onSelect={onSelect} />}
    </div>
  )
}

function Graph({
  m, snapshot, width, height, selected, onSelect,
}: {
  m: Model; snapshot: Snapshot; width: number; height: number; selected?: string | null; onSelect?: (name: string) => void
}) {
  const pos = layout(m.devices, width, height)
  const NW = 136, NH = 46
  const cx = width / 2, cy = height / 2

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="select-none" role="img" aria-label="Network topology">
      {m.links.map((l) => {
        const a = pos[l.a], b = pos[l.b]
        if (!a || !b) return null
        const tip = Object.entries(l.ends).map(([r, e]) => `${r} ${e.proto}: ${e.state}`).join("\n")
        return (
          <g key={l.a + l.b}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={l.up ? "var(--muted-foreground)" : "var(--destructive)"}
                  strokeOpacity={l.up ? 0.35 : 1} strokeWidth={l.up ? 1.5 : 2} strokeDasharray={l.up ? undefined : "5 4"} />
            {l.up && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--info)" strokeOpacity={0.55} strokeWidth={2}
                           strokeLinecap="round" strokeDasharray="2 22" className="animate-flow" />}
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="transparent" strokeWidth={12}><title>{tip}</title></line>
            {!l.up && (
              <g transform={`translate(${(a[0] + b[0]) / 2} ${(a[1] + b[1]) / 2})`}>
                <rect x={-20} y={-9} width={40} height={18} rx={9} fill="var(--destructive)" />
                <text textAnchor="middle" y={3.5} fontSize={10} fontWeight={600} fill="white">Down</text>
              </g>
            )}
          </g>
        )
      })}

      {m.externals.map((e, i) => {
        const [rx, ry] = pos[e.router] || [cx, cy]
        const ang = Math.atan2(ry - cy, rx - cx) + (i % 2 ? 0.45 : -0.45) * Math.ceil(i / 2)
        const ex = rx + Math.cos(ang) * 120, ey = Math.max(30, Math.min(height - 30, ry + Math.sin(ang) * 120))
        const up = e.state.startsWith("Established")
        return (
          <g key={e.router + e.proto}>
            <title>{`${e.neighbor} (AS${e.asn}) via ${e.router} · ${e.state}`}</title>
            <line x1={rx} y1={ry} x2={ex} y2={ey} stroke={up ? "var(--muted-foreground)" : "var(--destructive)"}
                  strokeOpacity={up ? 0.3 : 1} strokeDasharray="3 4" strokeWidth={1.5} />
            <circle cx={ex} cy={ey} r={22} fill="var(--card)" stroke={up ? "var(--border)" : "var(--destructive)"} strokeWidth={1.5} />
            <text x={ex} y={ey + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="var(--muted-foreground)">
              AS{e.asn ?? "?"}
            </text>
          </g>
        )
      })}

      {m.devices.map((d, i) => {
        const [x, y] = pos[d.name]
        const sel = selected === d.name
        const sessions = Object.keys(snapshot.sessions[d.name] || {}).length
        return (
          <g key={d.name} transform={`translate(${x - NW / 2} ${y - NH / 2})`} onClick={() => onSelect?.(d.name)}
             className={cn(onSelect && "cursor-pointer")}>
           <motion.g initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} whileHover={onSelect && { scale: 1.04 }}
                     transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.05 * i }}
                     style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            {d.status !== "ok" && (  // halo pulsing around a device that needs attention
              <rect x={-3} y={-3} width={NW + 6} height={NH + 6} rx={13} fill="none" stroke={STROKE[d.status]} strokeWidth={2}>
                <animate attributeName="opacity" values="0.7;0;0.7" dur="2s" repeatCount="indefinite" />
              </rect>
            )}
            <rect width={NW} height={NH} rx={12} fill="var(--card)"
                  stroke={sel ? "var(--primary)" : STROKE[d.status]} strokeWidth={sel || d.status !== "ok" ? 1.75 : 1}
                  style={{ filter: "drop-shadow(0 2px 6px rgb(0 0 0 / 0.08))" }} />
            <rect x={10} y={11} width={24} height={24} rx={7} fill={sel ? "var(--primary)" : "var(--muted)"} fillOpacity={sel ? 0.12 : 1} />
            <g transform="translate(14 15)" stroke={sel ? "var(--primary)" : "var(--muted-foreground)"} strokeWidth={1.5} fill="none" strokeLinecap="round">
              <rect x={0.5} y={4} width={15} height={8} rx={2} />
              <path d="M4 8h.01M7 8h.01" />
            </g>
            <circle cx={33} cy={13} r={4} fill={FILL[d.status]} stroke="var(--card)" strokeWidth={2} />
            <text x={44} y={20} fontSize={12.5} fontWeight={600} fill="var(--foreground)">{d.name}</text>
            <text x={44} y={35} fontSize={10.5} fill="var(--muted-foreground)">
              {[d.role, d.asn != null && `AS${d.asn}`].filter(Boolean).join(" · ") || `${sessions} sessions`}
            </text>
           </motion.g>
          </g>
        )
      })}
    </svg>
  )
}
