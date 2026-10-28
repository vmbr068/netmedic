// Camera motion tracker (pan + zoom) on a 160 px grey thumbnail of each video frame.
// "World" = the coordinates of the first frame tracked. Every detection is stored in world
// coordinates, then drawn through the current camera transform, so it stays glued to the rack
// while the phone moves, between two (slow) SAM refreshes.

// 2D transform on normalised video coordinates: p' = s*p + b
export type Transform = { s: number; bx: number; by: number }
export type Box = [number, number, number, number]

export const ident = (): Transform => ({ s: 1, bx: 0, by: 0 })
export const compose = (A: Transform, B: Transform): Transform => ({ s: A.s * B.s, bx: A.s * B.bx + A.bx, by: A.s * B.by + A.by })
export const inverse = (T: Transform): Transform => ({ s: 1 / T.s, bx: -T.bx / T.s, by: -T.by / T.s })
export const apply = (T: Transform, x: number, y: number): [number, number] => [T.s * x + T.bx, T.s * y + T.by]
export const applyBox = (T: Transform, b: Box | number[]): Box => [...apply(T, b[0], b[1]), ...apply(T, b[2], b[3])]

type Level = { g: Float32Array; w: number; h: number }
type Rect = [number, number, number, number]
type Est = { s: number; tx: number; ty: number }

// Mean-removed SSD per pixel between rect of a and the same rect of b shifted by (dx, dy):
// insensitive to the exposure changes of a phone camera.
function cost(a: Float32Array, b: Float32Array, w: number, h: number, rect: Rect, dx: number, dy: number) {
  let n = 0, sd = 0, sdd = 0
  for (let y = rect[1]; y < rect[3]; y++) {
    const yb = y + dy
    if (yb < 0 || yb >= h) continue
    for (let x = rect[0]; x < rect[2]; x++) {
      const xb = x + dx
      if (xb < 0 || xb >= w) continue
      const d = a[y * w + x] - b[yb * w + xb]
      sd += d; sdd += d * d; n++
    }
  }
  return n < 16 ? Infinity : (sdd - (sd * sd) / n) / n
}

function search(a: Float32Array, b: Float32Array, w: number, h: number, rect: Rect, cx: number, cy: number, r: number): [number, number, number] {
  let best = Infinity, bx = cx, by = cy
  for (let dy = cy - r; dy <= cy + r; dy++) for (let dx = cx - r; dx <= cx + r; dx++) {
    const c = cost(a, b, w, h, rect, dx, dy)
    if (c < best) { best = c; bx = dx; by = dy }
  }
  return [bx, by, best]
}

function subpixel(a: Float32Array, b: Float32Array, w: number, h: number, rect: Rect, bx: number, by: number, c0: number): [number, number] {
  const p = (l: number, r: number) => {  // parabola through the 3 costs on each axis
    const d = l - 2 * c0 + r
    return Number.isFinite(d) && d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0
  }
  return [bx + p(cost(a, b, w, h, rect, bx - 1, by), cost(a, b, w, h, rect, bx + 1, by)),
          by + p(cost(a, b, w, h, rect, bx, by - 1), cost(a, b, w, h, rect, bx, by + 1))]
}

function variance(g: Float32Array, w: number, rect: Rect) {
  let s = 0, ss = 0, n = 0
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) { const v = g[y * w + x]; s += v; ss += v * v; n++ }
  return n ? ss / n - (s / n) ** 2 : 0
}

type Pt = { px: number; py: number; dx: number; dy: number }
function fit(pts: Pt[]): Est {  // least squares for d = (s-1) p + t
  const n = pts.length, m = (f: (p: Pt) => number) => pts.reduce((acc, p) => acc + f(p), 0) / n
  const px = m((p) => p.px), py = m((p) => p.py), dx = m((p) => p.dx), dy = m((p) => p.dy)
  let num = 0, den = 0
  for (const p of pts) { num += (p.px - px) * (p.dx - dx) + (p.py - py) * (p.dy - dy); den += (p.px - px) ** 2 + (p.py - py) ** 2 }
  const k = den > 0 ? num / den : 0
  return { s: 1 + k, tx: dx - k * px, ty: dy - k * py }
}

export class Tracker {
  readonly W = 160
  H = 90
  M: Transform = ident()  // world -> current frame
  ok = 1                  // tracking confidence, drives the overlay opacity
  private key: Level[] | null = null
  private keyM: Transform = ident()
  private A: Est = { s: 1, tx: 0, ty: 0 }
  private canvas = document.createElement("canvas")
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!

  reset() { this.key = null; this.M = ident(); this.keyM = ident(); this.ok = 1 }

  private grab(video: HTMLVideoElement): Level[] {
    this.H = Math.max(8, Math.round((this.W * video.videoHeight) / video.videoWidth))
    if (this.canvas.width !== this.W || this.canvas.height !== this.H) { this.canvas.width = this.W; this.canvas.height = this.H }
    this.ctx.drawImage(video, 0, 0, this.W, this.H)
    const d = this.ctx.getImageData(0, 0, this.W, this.H).data, g = new Float32Array(this.W * this.H)
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11
    const levels: Level[] = [{ g, w: this.W, h: this.H }]
    for (let k = 0; k < 2; k++) {
      const p = levels[k], w = p.w >> 1, h = p.h >> 1, o = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = 2 * y * p.w + 2 * x
        o[y * w + x] = (p.g[i] + p.g[i + 1] + p.g[i + p.w] + p.g[i + p.w + 1]) / 4
      }
      levels.push({ g: o, w, h })
    }
    return levels
  }

  // Estimates the transform keyframe -> current frame. Tracking against a keyframe (not frame to
  // frame) avoids drift while the phone is held still; the keyframe is renewed after big moves.
  update(video: HTMLVideoElement) {
    const cur = this.grab(video)
    if (!this.key || this.key[0].w !== cur[0].w || this.key[0].h !== cur[0].h) {
      this.key = cur; this.keyM = this.M; this.A = { s: 1, tx: 0, ty: 0 }
      return
    }
    const k = this.key, A = this.A

    // 1. global translation, coarse to fine around the previous estimate
    let gx = Math.round(A.tx / 4), gy = Math.round(A.ty / 4)
    for (let lv = 2; lv >= 0; lv--) {
      const { w, h } = k[lv], mx = Math.round(w * 0.15), my = Math.round(h * 0.15)
      ;[gx, gy] = search(k[lv].g, cur[lv].g, w, h, [mx, my, w - mx, h - my], gx, gy, lv === 2 ? 4 : 1)
      if (lv > 0) { gx *= 2; gy *= 2 }
    }

    // 2. 3x3 patches around the prediction, sub-pixel, then fit pan + zoom
    const { w, h } = k[0], cx = w / 2, cy = h / 2, pw = Math.round(w / 6), ph = Math.round(h / 5), pts: Pt[] = []
    for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) {
      const px = Math.round((w * i) / 4), py = Math.round((h * j) / 4)
      const rect: Rect = [px - (pw >> 1), py - (ph >> 1), px + (pw >> 1), py + (ph >> 1)]
      const v = variance(k[0].g, w, rect)
      if (v < 25) continue  // flat area: nothing to lock on
      const ex = Math.round((A.s - 1) * (px - cx) + gx), ey = Math.round((A.s - 1) * (py - cy) + gy)
      const [bx, by, c] = search(k[0].g, cur[0].g, w, h, rect, ex, ey, 2)
      if (!(c < 0.5 * v)) continue  // poor match: occlusion, blur or too fast
      const [sx, sy] = subpixel(k[0].g, cur[0].g, w, h, rect, bx, by, c)
      pts.push({ px: px - cx, py: py - cy, dx: sx, dy: sy })
    }
    let est = pts.length >= 4 ? fit(pts) : { s: A.s, tx: gx, ty: gy }
    if (pts.length >= 5) {  // drop outliers (a hand passing by) and refit
      const good = pts.filter((p) => Math.hypot(p.dx - ((est.s - 1) * p.px + est.tx), p.dy - ((est.s - 1) * p.py + est.ty)) < 1.2)
      if (good.length >= 4) est = fit(good)
    }
    est.s = Math.max(0.6, Math.min(1.6, est.s))
    this.A = est
    this.M = compose({ s: est.s, bx: ((1 - est.s) * cx + est.tx) / w, by: ((1 - est.s) * cy + est.ty) / h }, this.keyM)

    const lost = pts.length < 3
    this.ok = lost ? Math.max(0, this.ok - 0.12) : Math.min(1, this.ok + 0.05)
    if (lost || Math.abs(est.s - 1) > 0.08 || Math.abs(est.tx) > w * 0.15 || Math.abs(est.ty) > h * 0.15) {
      this.key = cur; this.keyM = this.M; this.A = { s: 1, tx: 0, ty: 0 }
    }
  }
}
