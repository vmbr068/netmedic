import { useEffect, useRef, useState } from "react"
import { motion } from "motion/react"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import type { Device, Model, Snapshot } from "@/lib/api"

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

// Spectrum colors resolved to CSS values at build time, so the SVG follows light/dark like the rest of the page.
const C = {
  card: style({ fill: "gray-25" }),
  border: style({ stroke: "gray-300" }),
  heading: style({ fill: "gray-900" }),
  subdued: style({ fill: "gray-600" }),
  muted: style({ fill: "gray-100" }),
}
const STROKE = { ok: style({ stroke: "gray-300" }), warn: style({ stroke: "notice-800" }), bad: style({ stroke: "negative-900" }) }
const FILL = { ok: style({ fill: "positive-900" }), warn: style({ fill: "notice-800" }), bad: style({ fill: "negative-900" }) }
const LINE = { up: style({ stroke: "gray-500" }), down: style({ stroke: "negative-900" }), flow: style({ stroke: "accent-900" }) }

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
    <div ref={ref} className={className} style={{ height, width: "100%" }}>
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
  // Shrink the cards when the widest layer would not fit side by side (phones).
  const perLayer = new Map<number, number>()
  m.devices.forEach((d) => d.layer != null && perLayer.set(d.layer, (perLayer.get(d.layer) ?? 0) + 1))
  const widest = Math.max(1, ...perLayer.values())
  const NW = m.devices.every((d) => d.layer != null) ? Math.min(164, Math.floor(width / (widest + 1)) - 8) : 164, NH = 56
  const compact = NW < 150
  const ER = 26  // external AS bubble radius
  const layered = m.devices.length > 0 && m.devices.every((d) => d.layer != null)
  const cx = width / 2, cy = height / 2

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={style({ userSelect: "none", fontFamily: "sans" })} role="img" aria-label="Network topology">
      {m.links.map((l) => {
        const a = pos[l.a], b = pos[l.b]
        if (!a || !b) return null
        const tip = Object.entries(l.ends).map(([r, e]) => `${r} ${e.proto}: ${e.state}`).join("\n")
        return (
          <g key={l.a + l.b}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={l.up ? LINE.up : LINE.down}
                  strokeOpacity={l.up ? 0.5 : 1} strokeWidth={l.up ? 1.5 : 2} strokeDasharray={l.up ? undefined : "5 4"} />
            {l.up && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={LINE.flow + " animate-flow"} strokeOpacity={0.6} strokeWidth={2}
                           strokeLinecap="round" strokeDasharray="2 22" />}
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="transparent" strokeWidth={12}><title>{tip}</title></line>
            {!l.up && (
              <g transform={`translate(${(a[0] + b[0]) / 2} ${(a[1] + b[1]) / 2})`}>
                <rect x={-20} y={-9} width={40} height={18} rx={9} className={FILL.bad} />
                <text textAnchor="middle" y={3.5} fontSize={10} fontWeight={600} fill="white">Down</text>
              </g>
            )}
          </g>
        )
      })}

      {m.externals.map((e) => {
        const [rx, ry] = pos[e.router] || [cx, cy]
        // Fan the peers of one router symmetrically around the outward axis (a lone peer sits on it).
        const mine = m.externals.filter((x) => x.router === e.router)
        const k = mine.indexOf(e)
        // Layered layout: straight out sideways (or up for a centred router), so it looks the same at any panel size.
        // Ring layout: radially away from the centre.
        const axis = !layered ? Math.atan2(ry - cy, rx - cx) : Math.abs(rx - cx) < 1 ? -Math.PI / 2 : rx < cx ? Math.PI : 0
        const ang = axis + (k - (mine.length - 1) / 2) * 0.6
        // Out of the router card along the ray (clear of its edge), kept inside the view; if the clamp pushed it back onto the card, step sideways.
        const cos = Math.cos(ang), sin = Math.sin(ang)
        const edge = Math.min(NW / 2 / Math.max(Math.abs(cos), 1e-6), NH / 2 / Math.max(Math.abs(sin), 1e-6))
        const clampX = (x: number) => Math.max(ER + 4, Math.min(width - ER - 4, x)), clampY = (y: number) => Math.max(ER + 4, Math.min(height - ER - 4, y))
        let ex = clampX(rx + cos * (edge + ER + 24)), ey = clampY(ry + sin * (edge + ER + 24))
        if (Math.abs(ex - rx) < NW / 2 + ER + 6 && Math.abs(ey - ry) < NH / 2 + ER + 6) ex = clampX(rx + Math.sign(cos || 1) * (NW / 2 + ER + 16))
        const up = e.state.startsWith("Established")
        return (
          <g key={e.router + e.proto}>
            <title>{`${e.neighbor} (AS${e.asn}) via ${e.router} · ${e.state}`}</title>
            <line x1={rx} y1={ry} x2={ex} y2={ey} className={up ? LINE.up : LINE.down}
                  strokeOpacity={up ? 0.45 : 1} strokeDasharray="3 4" strokeWidth={1.5} />
            <circle cx={ex} cy={ey} r={ER} className={C.card + " " + (up ? C.border : LINE.down)} strokeWidth={1.5} />
            <text x={ex} y={ey + 3.5} textAnchor="middle" fontSize={11.5} fontWeight={600} className={C.subdued}>
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
             style={onSelect ? { cursor: "pointer" } : undefined}>
           <motion.g initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} whileHover={onSelect && { scale: 1.04 }}
                     transition={{ type: "spring", stiffness: 260, damping: 22, delay: 0.05 * i }}
                     style={{ transformBox: "fill-box", transformOrigin: "center" }}>
            {d.status !== "ok" && (  // halo pulsing around a device that needs attention
              <rect x={-3} y={-3} width={NW + 6} height={NH + 6} rx={11} fill="none" className={STROKE[d.status]} strokeWidth={2}>
                <animate attributeName="opacity" values="0.7;0;0.7" dur="2s" repeatCount="indefinite" />
              </rect>
            )}
            <rect width={NW} height={NH} rx={8} className={C.card + " " + (sel ? LINE.flow : STROKE[d.status])}
                  strokeWidth={sel ? 2 : d.status !== "ok" ? 1.75 : 1} />
            <rect x={12} y={14} width={28} height={28} rx={6} className={C.muted} />
            <g transform="translate(18 20)" className={sel ? LINE.flow : style({ stroke: "gray-700" })} strokeWidth={1.5} fill="none" strokeLinecap="round">
              <rect x={0.5} y={4} width={15} height={8} rx={2} />
              <path d="M4 8h.01M7 8h.01" />
            </g>
            <circle cx={39} cy={16} r={4.5} className={FILL[d.status]} />
            <text x={50} y={25} fontSize={15} fontWeight={700} className={C.heading}>{d.name}</text>
            <text x={50} y={42} fontSize={12.5} className={C.subdued}>
              {[d.role, !compact && d.asn != null && `AS${d.asn}`].filter(Boolean).join(" · ") || `${sessions} sessions`}
            </text>
           </motion.g>
          </g>
        )
      })}
    </svg>
  )
}
