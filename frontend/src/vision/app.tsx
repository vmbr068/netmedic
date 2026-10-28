import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Activity, ChevronDown, ChevronUp, ImageUp, Loader2, ScanLine, Spline, Video, VideoOff, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { VisionEngine, type Finding, type Tone, type VisionState } from "./engine"

const DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", bad: "bg-destructive", info: "bg-info", idle: "bg-muted-foreground" }
const SEV: Record<Finding["severity"], string> = { critical: "bg-destructive", warning: "bg-warning", info: "bg-info" }
const VERDICT = {
  confirmed: ["SAM confirmed", "bg-success/10 text-success"],
  unclear: ["SAM unsure", "bg-warning/15 text-amber-700"],
  disputed: ["SAM disputes", "bg-destructive/10 text-destructive"],
} as const

export default function VisionApp() {
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [engine, setEngine] = useState<VisionEngine | null>(null)

  useEffect(() => {
    const e = new VisionEngine(video.current!, canvas.current!)
    setEngine(e)
    e.start()
    return () => e.destroy()
  }, [])

  const s = useSyncExternalStore(engine?.subscribe ?? noop, engine?.getState ?? initial)

  const onFile = (f: File | undefined) => {
    if (!f || !engine) return
    const img = new Image()
    img.onload = () => engine.scan(img)
    img.src = URL.createObjectURL(f)
  }
  const shutter = () => {
    if (!engine) return
    if (s.frozen && s.scan) engine.resume()
    else if (s.camera) engine.scan()
    else file.current?.click()
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-neutral-950 text-foreground">
      <video ref={video} playsInline autoPlay muted className="absolute inset-0 size-full object-contain" />
      <canvas ref={canvas} className="absolute inset-0 size-full" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 p-3 pt-[max(env(safe-area-inset-top),12px)]">
        <a href="/" className="pointer-events-auto flex items-center gap-2 rounded-full bg-background/95 py-1.5 pr-3.5 pl-1.5 text-sm font-semibold shadow-sm backdrop-blur">
          <span className="grid size-7 place-items-center rounded-full bg-brand text-white"><Activity className="size-3.5" strokeWidth={2.5} /></span>
          Rack Vision
        </a>
        <span className="flex items-center gap-2 rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur">
          {s.scanning ? <Loader2 className="size-3 animate-spin text-info" /> : <span className={cn("size-2 rounded-full", DOT[s.status.tone])} />}
          {s.status.text}
        </span>
      </header>

      {s.camera === false && !s.frozen && (
        <div className="absolute inset-0 grid place-items-center bg-muted p-6">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            <span className="grid size-12 place-items-center rounded-xl bg-background shadow-sm"><VideoOff className="size-5 text-muted-foreground" /></span>
            <p className="font-medium">Camera unavailable</p>
            <p className="text-sm text-muted-foreground">HTTPS required · <code className="font-mono text-xs">netmedic watch --lan</code></p>
            <Button onClick={() => file.current?.click()}><ImageUp />Upload photo</Button>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {s.trace && engine && <TraceCard s={s} onClose={() => engine.clearTrace()} />}
        {s.scan && engine && <Results s={s} engine={engine} />}

        <div className="pointer-events-auto flex flex-col gap-3 rounded-2xl bg-background/95 p-3 shadow-lg backdrop-blur">
          {!s.scan && s.camera && (
            <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
              <Legend color="bg-success" label="Plugged" />
              <Legend color="bg-warning" label="Empty" />
              <span className="flex items-center gap-1.5"><Spline className="size-3" />Tap to trace</span>
            </div>
          )}
          <div className="flex items-center justify-around">
            <Button variant={s.live ? "default" : "outline"} size="icon-lg" className="rounded-full" disabled={!s.camera || s.frozen}
                    onClick={() => engine?.setLive(!s.live)} aria-label="Live detection">
              {s.live ? <Video /> : <VideoOff />}
            </Button>
            <button onClick={shutter} disabled={s.scanning} aria-label={s.frozen ? "Back to live" : "Scan"}
              className="grid size-16 place-items-center rounded-full border-4 border-foreground/90 transition active:scale-95 disabled:opacity-60">
              <span className={cn("grid size-12 place-items-center rounded-full bg-brand text-white shadow-lg shadow-primary/40", s.scanning && "animate-pulse")}>
                {s.frozen && s.scan && s.camera ? <Video className="size-5" /> : <ScanLine className="size-5" />}
              </span>
            </button>
            <Button variant="outline" size="icon-lg" className="rounded-full" onClick={() => file.current?.click()} aria-label="Upload photo">
              <ImageUp />
            </Button>
          </div>
        </div>
      </div>

      <input ref={file} type="file" accept="image/*" capture="environment" className="hidden"
             onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = "" }} />
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cn("size-2 rounded-sm", color)} />{label}</span>
}

function TraceCard({ s, onClose }: { s: VisionState; onClose: () => void }) {
  const t = s.trace!
  return (
    <div className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-background/95 p-3 shadow-lg backdrop-blur">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-info/10 text-info">
        {t.pending ? <Loader2 className="size-4 animate-spin" /> : <Spline className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {t.pending ? <p className="pt-1.5 font-medium">Tracing…</p> : (
          <>
            <p className="font-medium">{t.start || "Cable"}</p>
            <p className="text-muted-foreground">→ {t.end || "End not visible"}</p>
            {t.note && <p className="mt-0.5 text-xs text-muted-foreground">{t.note}</p>}
          </>
        )}
      </div>
      {typeof t.confidence === "number" && <Badge variant="secondary" className="mt-1 tabular-nums">{Math.round(t.confidence * 100)}%</Badge>}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close"><X /></Button>
    </div>
  )
}

function Results({ s, engine }: { s: VisionState; engine: VisionEngine }) {
  const scan = s.scan!
  return (
    <div className="pointer-events-auto flex flex-col rounded-2xl bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 p-3 pb-2">
        <p className="flex-1 text-sm font-medium">{scan.findings.length ? `${scan.findings.length} finding${scan.findings.length > 1 ? "s" : ""}` : "No anomaly"}</p>
        <Button variant="ghost" size="sm" onClick={() => engine.setCollapsed(!s.collapsed)}>
          {s.collapsed ? <ChevronUp /> : <ChevronDown />}{s.collapsed ? "Show" : "Hide"}
        </Button>
        {s.camera && <Button size="sm" onClick={() => engine.resume()}><Video />Live</Button>}
      </div>
      {!s.collapsed && (
        <div className="max-h-[34vh] overflow-y-auto px-3 pb-3">
          {scan.summary && <p className="mb-2 text-sm text-muted-foreground">{scan.summary}</p>}
          <ul className="flex flex-col gap-1.5">
            {scan.findings.map((f, i) => (
              <li key={i}>
                <button onClick={() => engine.select(i)}
                  className={cn("flex w-full gap-3 rounded-xl border p-2.5 text-left transition-colors", s.selected === i ? "border-foreground" : "hover:bg-muted")}>
                  <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white", SEV[f.severity] ?? "bg-info")}>{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{f.title}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{f.detail}</span>
                    {f.verdict && f.verdict in VERDICT && (
                      <Badge className={cn("mt-1.5 border-0", VERDICT[f.verdict as keyof typeof VERDICT][1])}>
                        {VERDICT[f.verdict as keyof typeof VERDICT][0]}
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const noop = () => () => {}
const initialState: VisionState = {
  camera: null, live: true, status: { tone: "idle", text: "Starting" }, scanning: false,
  frozen: false, scan: null, selected: -1, collapsed: false, trace: null,
}
const initial = () => initialState
