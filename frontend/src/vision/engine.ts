// Rack Vision engine: camera, live SAM ports, deep scan, cable trace and the canvas overlay.
// React only renders the controls; this keeps the 60 fps drawing loop out of React.
import { apply, applyBox, ident, inverse, Tracker, type Box, type Transform } from "./tracker"

export type Kind = "empty" | "plugged"
export type Finding = {
  title: string; detail: string; severity: "info" | "warning" | "critical"; related?: string
  box: Box; anchors?: Box[]; verdict?: "confirmed" | "unclear" | "disputed" | "unverified"; verdict_note?: string
}
export type ScanResult = {
  summary: string; model: string; latency: number
  devices: { name: string; box: Box }[]; objects: { kind: Kind; box: Box }[]; findings: Finding[]
}
export type TraceInfo = { pending: boolean; start?: string; end?: string; note?: string; confidence?: number | null }
export type Tone = "ok" | "warn" | "bad" | "info" | "idle"

export type VisionState = {
  camera: boolean | null  // null while starting
  live: boolean
  status: { tone: Tone; text: string }
  scanning: boolean
  frozen: boolean
  scan: ScanResult | null
  selected: number
  collapsed: boolean
  trace: TraceInfo | null
}

const COLOR = { empty: "#f59e0b", plugged: "#16a34a", trace: "#2563eb", device: "#2563eb" }
const SEV = { critical: "#dc2626", warning: "#f59e0b", info: "#2563eb" }

type Track = { kind: Kind; target: Box; shown: Box; alpha: number; dead: boolean }
type Trace = TraceInfo & { space: "world" | "still"; at: [number, number]; pts: [number, number][]; t0: number }

async function post(path: string, blob: Blob) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText)
  return r.json()
}

function iou(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
  return u > 0 ? i / u : 0
}

// Grab the current frame (or a still image) as a downscaled JPEG.
function frameBlob(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, maxSide = 1280) {
  const w = (source as HTMLVideoElement).videoWidth || (source as HTMLImageElement).naturalWidth || source.width
  const h = (source as HTMLVideoElement).videoHeight || (source as HTMLImageElement).naturalHeight || source.height
  const k = Math.min(1, maxSide / Math.max(w, h))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(w * k); canvas.height = Math.round(h * k)
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise<{ blob: Blob; canvas: HTMLCanvasElement }>((ok) => canvas.toBlob((b) => ok({ blob: b!, canvas }), "image/jpeg", 0.8))
}

export class VisionEngine {
  state: VisionState = {
    camera: null, live: true, status: { tone: "idle", text: "Starting camera" }, scanning: false,
    frozen: false, scan: null, selected: -1, collapsed: false, trace: null,
  }
  private listeners = new Set<() => void>()
  private ctx: CanvasRenderingContext2D
  private tracker = new Tracker()
  private tracks: Track[] = []
  private trace: Trace | null = null
  private frozen: HTMLCanvasElement | null = null
  private looping = false
  private liveBusy = false
  private raf = 0

  private video: HTMLVideoElement
  private canvas: HTMLCanvasElement

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    this.video = video
    this.canvas = canvas
    this.ctx = canvas.getContext("2d")!
    canvas.addEventListener("click", this.onTap)
    this.raf = requestAnimationFrame(this.draw)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener("click", this.onTap)
    ;(this.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getState = () => this.state
  private set(patch: Partial<VisionState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((fn) => fn()) }
  private status(tone: Tone, text: string) { this.set({ status: { tone, text } }) }

  // ---------- camera & live ports ----------
  async start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      })
      this.video.srcObject = stream
      await this.video.play()
      this.set({ camera: true })
      this.status("ok", "Live")
      this.kick()
    } catch {
      this.set({ camera: false, live: false })
      this.status("idle", "Photo mode")
    }
  }

  setLive(live: boolean) {
    this.tracks = []
    this.set({ live: live && !!this.state.camera })
    this.status(this.state.live ? "ok" : "idle", this.state.live ? "Live" : "Paused")
    this.kick()
  }

  private kick() { if (!this.looping) { this.looping = true; this.liveLoop() } }

  private liveLoop = async () => {
    if (!this.state.live || this.frozen || !this.state.camera) { this.looping = false; return }
    if (!this.liveBusy && this.video.videoWidth) {
      this.liveBusy = true
      try {
        const Mcap = { ...this.tracker.M }  // camera pose when the frame was taken
        const { blob } = await frameBlob(this.video, 960)
        const res = await post("/api/vision/ports", blob)
        if (!this.frozen && this.state.live) {
          this.ingest(res.objects, Mcap)
          this.tracker.ok = 1
          const n = (k: Kind) => res.objects.filter((o: { kind: Kind }) => o.kind === k).length
          this.status("ok", `${n("plugged")} plugged · ${n("empty")} empty`)
        }
      } catch { this.status("bad", "Detection failed") }
      this.liveBusy = false
    }
    setTimeout(this.liveLoop, 150)
  }

  // New detections are matched to the ports already shown, which then glide to their new box
  // instead of blinking; unmatched ones fade in or out.
  private ingest(objects: { kind: Kind; box: Box }[], Mcap: Transform) {
    const inv = inverse(Mcap), used = new Set<Track>()
    for (const o of objects) {
      const box = applyBox(inv, o.box)
      let best: Track | null = null, score = 0.2
      for (const t of this.tracks) if (!used.has(t) && t.kind === o.kind) { const v = iou(t.target, box); if (v > score) { score = v; best = t } }
      if (best) { best.target = box; best.dead = false; used.add(best) }
      else { const t: Track = { kind: o.kind, target: box, shown: [...box] as Box, alpha: 0, dead: false }; this.tracks.push(t); used.add(t) }
    }
    for (const t of this.tracks) if (!used.has(t)) t.dead = true
  }

  // ---------- deep scan ----------
  async scan(source?: HTMLImageElement) {
    if (this.state.scanning) return
    const src = source ?? (this.state.camera ? this.video : null)
    if (!src) return
    this.set({ scanning: true, scan: null, selected: -1, collapsed: false, trace: null })
    this.trace = null
    this.status("info", "Analysing")
    try {
      const { blob, canvas } = await frameBlob(src, 1280)
      this.frozen = canvas
      this.set({ frozen: true })
      const scan: ScanResult = await post("/api/vision/scan", blob)
      this.set({ scan })
      this.status("idle", `${scan.findings.length} finding${scan.findings.length === 1 ? "" : "s"} · ${scan.latency}s`)
    } catch (e) {
      this.frozen = null
      this.set({ frozen: false })
      this.status("bad", `Scan failed: ${(e as Error).message}`)
      this.kick()
    }
    this.set({ scanning: false })
  }

  resume() {
    this.frozen = null; this.trace = null; this.tracks = []
    this.tracker.reset()
    this.set({ frozen: false, scan: null, selected: -1, collapsed: false, trace: null })
    this.status(this.state.live ? "ok" : "idle", this.state.live ? "Live" : "Ready")
    this.kick()
  }

  select(i: number) { this.set({ selected: i, collapsed: false }) }
  setCollapsed(collapsed: boolean) { this.set({ collapsed }) }
  clearTrace() { this.trace = null; this.set({ trace: null }) }

  // ---------- cable trace ----------
  private portAt(nx: number, ny: number) {
    const boxes = this.frozen
      ? (this.state.scan?.objects ?? [])
      : this.tracks.filter((t) => !t.dead).map((t) => ({ kind: t.kind, box: applyBox(this.tracker.M, t.shown) }))
    const pad = 0.012
    const hits = boxes.filter(({ box: b }) => nx >= b[0] - pad && nx <= b[2] + pad && ny >= b[1] - pad && ny <= b[3] + pad)
    const dist = ({ box: b }: { box: Box }) => Math.hypot((b[0] + b[2]) / 2 - nx, (b[1] + b[3]) / 2 - ny)
    return hits.sort((a, b) => dist(a) - dist(b))[0] ?? null
  }

  private setTrace(t: Trace | null) {
    this.trace = t
    this.set({ trace: t && { pending: t.pending, start: t.start, end: t.end, note: t.note, confidence: t.confidence } })
  }

  private async runTrace(nx: number, ny: number) {
    if (this.trace?.pending) return
    const still = !!this.frozen, Mcap = still ? ident() : { ...this.tracker.M }
    const toSpace = (x: number, y: number): [number, number] => (still ? [x, y] : apply(inverse(Mcap), x, y))
    const space = still ? "still" : "world"
    const port = this.portAt(nx, ny)
    if (port?.kind === "empty") {  // SAM only sees pixels: no need to ask the language model
      this.setTrace({ space, at: toSpace(nx, ny), t0: performance.now(), pending: false, pts: [],
                      start: "Empty port", end: "Nothing plugged (SAM 3.1)", confidence: null })
      return
    }
    if (port) { nx = (port.box[0] + port.box[2]) / 2; ny = (port.box[1] + port.box[3]) / 2 }  // snap onto the plug
    const { blob } = await frameBlob(still ? this.frozen! : this.video, 1280)
    const base = { space, at: toSpace(nx, ny), t0: performance.now() } as const
    this.setTrace({ ...base, pending: true, pts: [] })
    try {
      const res = await post(`/api/vision/trace?x=${nx.toFixed(4)}&y=${ny.toFixed(4)}${port ? "&plugged=true" : ""}`, blob)
      this.setTrace({ ...base, pending: false, start: res.start, end: res.end, note: res.note, confidence: res.confidence,
                      pts: res.path.map(([x, y]: [number, number]) => toSpace(x, y)), t0: performance.now() })
    } catch (e) {
      this.setTrace(null)
      this.status("bad", `Trace failed: ${(e as Error).message}`)
    }
  }

  private onTap = (e: MouseEvent) => {
    const src = this.frozen ? [this.frozen.width, this.frozen.height] : [this.video.videoWidth, this.video.videoHeight]
    if (!src[0] || (!this.frozen && !this.state.camera)) return
    const rect = this.canvas.getBoundingClientRect(), r = this.fitRect(src[0], src[1])
    const nx = (e.clientX - rect.left - r.x) / r.w, ny = (e.clientY - rect.top - r.y) / r.h
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
    const scan = this.state.scan
    if (this.frozen && scan) {  // tapping a finding opens it, anywhere else traces a cable
      const hit = scan.findings.findIndex((f) => nx >= f.box[0] && nx <= f.box[2] && ny >= f.box[1] && ny <= f.box[3])
      if (hit >= 0 && (hit !== this.state.selected || this.state.collapsed)) { this.select(hit); return }
      if (!this.state.collapsed) this.setCollapsed(true)
    }
    if (this.frozen && !scan) return  // scan still running
    this.runTrace(nx, ny)
  }

  // ---------- drawing ----------
  private fitRect(srcW: number, srcH: number) {  // object-fit: contain; a still photo sits right under the top bar
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight, k = Math.min(W / srcW, H / srcH)
    const r = { x: (W - srcW * k) / 2, y: (H - srcH * k) / 2, w: srcW * k, h: srcH * k }
    if (this.frozen) r.y = Math.min(r.y, 64)
    return r
  }

  private box(r: Rect, b: Box, color: string, o: { width?: number; dash?: number[]; fill?: string; label?: string; badge?: string } = {}) {
    const ctx = this.ctx, x = r.x + b[0] * r.w, y = r.y + b[1] * r.h, w = (b[2] - b[0]) * r.w, h = (b[3] - b[1]) * r.h
    ctx.save()
    ctx.lineWidth = o.width ?? 2; ctx.strokeStyle = color; ctx.setLineDash(o.dash ?? [])
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(x, y, w, h) }
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.stroke()
    ctx.font = "600 12px 'Geist Variable', ui-sans-serif, sans-serif"
    if (o.label) {
      const tw = ctx.measureText(o.label).width + 12
      ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, Math.max(0, y - 22), tw, 18, 5); ctx.fill()
      ctx.fillStyle = "#fff"; ctx.fillText(o.label, x + 6, Math.max(13, y - 9))
    }
    if (o.badge) {
      ctx.beginPath(); ctx.arc(x + w, y, 11, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill()
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke()
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(o.badge, x + w, y + 4)
    }
    ctx.restore()
  }

  private brackets(r: Rect, b: Box, kind: Kind, alpha: number) {  // AR-style corner brackets around a port
    const ctx = this.ctx, color = COLOR[kind]
    const x = r.x + b[0] * r.w, y = r.y + b[1] * r.h, w = (b[2] - b[0]) * r.w, h = (b[3] - b[1]) * r.h
    const l = Math.max(3, Math.min(w, h) * 0.32)
    ctx.save(); ctx.globalAlpha = alpha
    ctx.fillStyle = color + (kind === "empty" ? "33" : "14"); ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.beginPath()
    ctx.moveTo(x, y + l); ctx.lineTo(x, y); ctx.lineTo(x + l, y)
    ctx.moveTo(x + w - l, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + l)
    ctx.moveTo(x + w, y + h - l); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - l, y + h)
    ctx.moveTo(x + l, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - l)
    ctx.stroke(); ctx.restore()
  }

  private drawTrace(r: Rect, T: Transform | null, now: number) {
    const t = this.trace, ctx = this.ctx
    if (!t || t.space !== (this.frozen ? "still" : "world")) return
    const map = ([x, y]: [number, number]): [number, number] => { const [u, v] = T ? apply(T, x, y) : [x, y]; return [r.x + u * r.w, r.y + v * r.h] }
    ctx.save()
    if (t.pending) {  // pulsing ring where the user tapped
      const [x, y] = map(t.at), k = ((now - t.t0) % 1200) / 1200
      ctx.strokeStyle = `rgba(37,99,235,${1 - k})`; ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(x, y, 8 + 26 * k, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = COLOR.trace; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill()
    } else if (t.pts.length < 2) {  // nothing to follow (empty port): mark the spot
      const [x, y] = map(t.at)
      ctx.strokeStyle = COLOR.empty; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke()
    } else {
      const all = t.pts.map(map), grow = Math.min(1, (now - t.t0) / 700)
      const pts = all.slice(0, Math.max(2, Math.ceil(all.length * grow)))
      const path = () => {  // smooth curve through the midpoints
        ctx.beginPath(); ctx.moveTo(...pts[0])
        for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(...pts[i], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2)
        ctx.lineTo(...pts[pts.length - 1])
      }
      ctx.lineJoin = ctx.lineCap = "round"
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 9; path(); ctx.stroke()
      ctx.strokeStyle = COLOR.trace; ctx.lineWidth = 4; ctx.setLineDash([12, 8]); ctx.lineDashOffset = -now / 25; path(); ctx.stroke()
      ctx.setLineDash([])
      const dot = ([x, y]: [number, number], c: string) => {
        ctx.fillStyle = c; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      }
      dot(all[0], COLOR.trace)
      if (grow === 1) dot(all[all.length - 1], COLOR.plugged)
    }
    ctx.restore()
  }

  private draw = (now: number) => {
    const ctx = this.ctx, c = this.canvas, dpr = window.devicePixelRatio || 1
    if (c.width !== c.clientWidth * dpr || c.height !== c.clientHeight * dpr) { c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight)
    const scan = this.state.scan
    if (this.frozen) {
      const r = this.fitRect(this.frozen.width, this.frozen.height)
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--background") || "#f7f8fa"
      ctx.fillRect(0, 0, c.clientWidth, c.clientHeight)
      ctx.save(); ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 12); ctx.clip()
      ctx.drawImage(this.frozen, r.x, r.y, r.w, r.h); ctx.restore()
      if (scan) {
        for (const o of scan.objects) this.brackets(r, o.box, o.kind, o.kind === "empty" ? 1 : 0.6)
        for (const d of scan.devices) this.box(r, d.box, COLOR.device, { dash: [6, 4], width: 1.5, label: d.name })
        scan.findings.forEach((f, i) => {
          const color = SEV[f.severity] ?? SEV.info, on = this.state.selected === i
          const doubtful = f.verdict === "disputed" || f.verdict === "unclear"
          for (const a of f.anchors ?? []) this.box(r, a, color, { width: 2.5, fill: color + "40" })
          this.box(r, f.box, doubtful ? SEV.warning : color, { width: on ? 4 : 2.5, badge: String(i + 1), dash: doubtful ? [7, 5] : [] })
        })
      }
      this.drawTrace(r, null, now)
    } else if (this.video.videoWidth && this.state.camera) {
      this.tracker.update(this.video)
      const r = this.fitRect(this.video.videoWidth, this.video.videoHeight), M = this.tracker.M
      this.tracks = this.tracks.filter((t) => !(t.dead && t.alpha < 0.02))
      for (const t of this.tracks) {
        for (let i = 0; i < 4; i++) t.shown[i] += (t.target[i] - t.shown[i]) * 0.3
        t.alpha += ((t.dead ? 0 : 1) - t.alpha) * 0.15
        this.brackets(r, applyBox(M, t.shown), t.kind, t.alpha * (0.25 + 0.75 * this.tracker.ok) * (t.kind === "empty" ? 1 : 0.75))
      }
      this.drawTrace(r, M, now)
    }
    this.raf = requestAnimationFrame(this.draw)
  }
}

type Rect = { x: number; y: number; w: number; h: number }
