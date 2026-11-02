import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  ActionButton, Button, ButtonGroup, CloseButton, Content, Heading, IllustratedMessage, ListView, ListViewItem, ProgressCircle,
  Provider, StatusLight, Text, ToggleButton,
} from "@react-spectrum/s2"
import ChevronDown from "@react-spectrum/s2/icons/ChevronDown"
import ChevronUp from "@react-spectrum/s2/icons/ChevronUp"
import ImageAdd from "@react-spectrum/s2/icons/ImageAdd"
import CameraIllustration from "@react-spectrum/s2/illustrations/linear/Camera"
import Path from "@react-spectrum/s2/icons/Path"
import Camera from "@react-spectrum/s2/icons/Camera"
import Target from "@react-spectrum/s2/icons/Target"
import Video from "@react-spectrum/s2/icons/Video"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }
import { Button as AriaButton } from "react-aria-components"

import { VARIANT } from "@/components/status"
import { Logo } from "@/components/logo"
import type { PhotoRequest, ServerEvent } from "@/lib/api"
import { useColorScheme } from "@/lib/color-scheme"

import { VisionEngine, type Finding, type Tone, type VisionState } from "./engine"

const LIGHT = { ...VARIANT, idle: "neutral" } as const satisfies Record<Tone, string>
const SEV = { critical: "negative", warning: "notice", info: "informative" } as const satisfies Record<Finding["severity"], string>
const VERDICT = {
  confirmed: ["SAM confirmed", "positive"],
  unclear: ["SAM unsure", "notice"],
  disputed: ["SAM disputes", "negative"],
} as const

// Floating Spectrum surfaces over the camera feed.
const surface = style({ pointerEvents: "auto", backgroundColor: "layer-2", borderRadius: "xl", boxShadow: "elevated" })

export default function VisionApp() {
  const [scheme] = useColorScheme()
  return <Provider colorScheme={scheme} background="base"><Vision /></Provider>
}

function Vision() {
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
  const request = usePhotoRequest()

  const onFile = (f: File | undefined) => {
    if (!f || !engine) return
    const img = new Image()
    img.onload = () => engine.scan(img, request?.id)
    img.src = URL.createObjectURL(f)
  }
  const shutter = () => {
    if (!engine) return
    if (s.frozen && s.scan) engine.resume()
    else if (s.camera) engine.scan(undefined, request?.id)
    else file.current?.click()
  }
  const upload = () => file.current?.click()

  return (
    <div className={style({ position: "fixed", inset: 0, overflow: "hidden", backgroundColor: "black" })}>
      <video ref={video} playsInline autoPlay muted className={style({ position: "absolute", inset: 0, size: "full", objectFit: "contain" })} />
      <canvas ref={canvas} className={style({ position: "absolute", inset: 0, size: "full" })} />

      <header className={style({ pointerEvents: "none", position: "absolute", top: 0, insetX: 0, zIndex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 12 })}
              style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
       <div className={style({ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 })}>
        <a href="./" className={surface + " " + style({ display: "flex", alignItems: "center", gap: 8, paddingY: 4, paddingStart: 4, paddingEnd: 12, textDecoration: "none", font: "title-sm", borderRadius: "full" })}>
          <Logo size={28} />Rack Vision
        </a>
        <span className={surface + " " + style({ display: "flex", alignItems: "center", gap: 8, paddingX: 12, paddingY: 4, borderRadius: "full" })}>
          {s.scanning ? <><ProgressCircle size="S" isIndeterminate aria-label="Scanning" /><Text>{s.status.text}</Text></>
            : <StatusLight size="S" variant={LIGHT[s.status.tone]}>{s.status.text}</StatusLight>}
        </span>
       </div>
        {request && <RequestCard request={request} />}
      </header>

      {s.camera === false && !s.frozen && (
        <div className={style({ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "layer-1", padding: 24 })}>
          <IllustratedMessage>
            <CameraIllustration />
            <Heading>Camera unavailable</Heading>
            <Content>{s.cameraError ?? "The camera could not start"}. Upload a photo instead.</Content>
            <ButtonGroup><Button variant="accent" onPress={upload}><ImageAdd /><Text>Upload photo</Text></Button></ButtonGroup>
          </IllustratedMessage>
        </div>
      )}

      <div className={style({ pointerEvents: "none", position: "absolute", bottom: 0, insetX: 0, zIndex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 12 })}
           style={{ paddingBottom: "max(env(safe-area-inset-bottom), 12px)" }}>
        {s.trace && engine && <TraceCard s={s} onClose={() => engine.clearTrace()} />}
        {s.scan && engine && <Results s={s} engine={engine} />}

        <div className={surface + " " + style({ display: "flex", flexDirection: "column", gap: 12, padding: 12 })}>
          {!s.scan && s.camera && (
            <div className={style({ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 })}>
              <StatusLight size="S" variant="positive">Plugged</StatusLight>
              <StatusLight size="S" variant="notice">Empty</StatusLight>
              <span className={style({ display: "flex", alignItems: "center", gap: 4, font: "ui-sm", color: "neutral-subdued" })}>
                <Path styles={iconStyle({ size: "S" })} />Tap to trace
              </span>
            </div>
          )}
          <div className={style({ display: "flex", alignItems: "center", justifyContent: "space-around" })}>
            <ToggleButton aria-label="Live detection" size="L" isEmphasized isSelected={s.live} isDisabled={!s.camera || s.frozen}
                          onChange={(v) => engine?.setLive(v)}><Target /></ToggleButton>
            <AriaButton onPress={shutter} isDisabled={s.scanning} aria-label={s.frozen ? "Back to live" : "Scan"}
              className={style({
                size: 64, borderRadius: "full", borderWidth: 4, borderStyle: "solid", borderColor: "gray-800", backgroundColor: "transparent",
                display: "flex", alignItems: "center", justifyContent: "center", padding: 0, outlineStyle: "none",
                opacity: { default: 1, isDisabled: 0.6 }, scale: { default: 1, isPressed: 0.95 }, transition: "transform",
              })}>
              <span className={style({ size: 48, borderRadius: "full", backgroundColor: "accent-900", display: "flex", alignItems: "center", justifyContent: "center" })}>
                {s.scanning ? <ProgressCircle size="S" isIndeterminate staticColor="white" aria-label="Scanning" />
                  : s.frozen && s.scan && s.camera ? <Video styles={iconStyle({ color: "white" })} /> : <Target styles={iconStyle({ color: "white" })} />}
              </span>
            </AriaButton>
            <ActionButton size="L" aria-label="Upload photo" onPress={upload}><ImageAdd /></ActionButton>
          </div>
        </div>
      </div>

      <input ref={file} type="file" accept="image/*" capture="environment" className={style({ display: "none" })}
             onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = "" }} />
    </div>
  )
}

// Photos netmedic is waiting for, followed live on the event stream (replayed to a page opened late).
// The one to answer: ?request=<id> from the link in the live incident, else the oldest.
function usePhotoRequest(): PhotoRequest | null {
  const [pending, setPending] = useState<PhotoRequest[]>([])
  useEffect(() => {
    const es = new EventSource("/api/events")
    es.onmessage = (m) => {
      const ev: ServerEvent = JSON.parse(m.data)
      if (ev.kind === "vision_request") setPending((p) => [...p.filter((r) => r.id !== ev.data.id), ev.data])
      else if (ev.kind === "vision_resolved") setPending((p) => p.filter((r) => r.id !== ev.data.id))
      else if (ev.kind === "incident_opened") setPending([])
    }
    return () => es.close()
  }, [])
  const wanted = Number(new URLSearchParams(location.search).get("request"))
  return pending.find((r) => r.id === wanted) ?? pending[0] ?? null
}

function RequestCard({ request }: { request: PhotoRequest }) {
  return (
    <div className={surface + " " + style({ display: "flex", alignItems: "start", gap: 12, padding: 12, font: "body-sm" })}>
      <Camera styles={iconStyle({ color: "informative" })} />
      <div className={style({ flexGrow: 1, minWidth: 0 })}>
        <p className={style({ fontWeight: "bold", margin: 0 })}>netmedic needs a photo · {request.target}</p>
        <p className={style({ color: "neutral-subdued", margin: 0 })}>{request.reason}</p>
        <p className={style({ font: "body-xs", color: "neutral-subdued", marginTop: 4, marginBottom: 0 })}>Frame that port and scan: the result goes to the investigation.</p>
      </div>
    </div>
  )
}

function TraceCard({ s, onClose }: { s: VisionState; onClose: () => void }) {
  const t = s.trace!
  const [hidden, setHidden] = useState(false)
  return (
    <div className={surface + " " + style({ display: "flex", alignItems: "start", gap: 12, padding: 12, font: "body-sm" })}>
      {t.pending ? <ProgressCircle size="S" isIndeterminate aria-label="Tracing" /> : <Path styles={iconStyle({ color: "informative" })} />}
      <div className={style({ flexGrow: 1, minWidth: 0 })}>
        {t.pending ? <p className={style({ fontWeight: "bold", margin: 0 })}>Tracing…</p> : (
          <>
            <p className={style({ fontWeight: "bold", margin: 0, truncate: true })}>{t.start || "Cable"}</p>
            {!hidden && (
              <>
                <p className={style({ color: "neutral-subdued", margin: 0 })}>→ {t.end || "End not visible"}{typeof t.confidence === "number" && ` · ${Math.round(t.confidence * 100)}%`}</p>
                {t.note && <p className={style({ font: "body-xs", color: "neutral-subdued", marginTop: 2, marginBottom: 0 })}>{t.note}</p>}
              </>
            )}
          </>
        )}
      </div>
      {!t.pending && (
        <ActionButton isQuiet size="S" onPress={() => setHidden(!hidden)} styles={style({ flexShrink: 0 })}>
          {hidden ? <ChevronUp /> : <ChevronDown />}<Text>{hidden ? "Show" : "Hide"}</Text>
        </ActionButton>
      )}
      <CloseButton size="S" onPress={onClose} aria-label="Close" />
    </div>
  )
}

function Results({ s, engine }: { s: VisionState; engine: VisionEngine }) {
  const scan = s.scan!
  return (
    <div className={surface + " " + style({ display: "flex", flexDirection: "column" })}>
      <div className={style({ display: "flex", alignItems: "center", gap: 8, padding: 12, paddingBottom: 8 })}>
        <p className={style({ font: "title-sm", flexGrow: 1, margin: 0 })}>
          {scan.findings.length ? `${scan.findings.length} finding${scan.findings.length > 1 ? "s" : ""}` : "No anomaly"}
        </p>
        <ActionButton isQuiet size="S" onPress={() => engine.setCollapsed(!s.collapsed)}>
          {s.collapsed ? <ChevronUp /> : <ChevronDown />}<Text>{s.collapsed ? "Show" : "Hide"}</Text>
        </ActionButton>
        {s.camera && <Button size="S" variant="accent" onPress={() => engine.resume()}><Video /><Text>Live</Text></Button>}
      </div>
      {!s.collapsed && (
        <div className={style({ paddingX: 12, paddingBottom: 12, display: "flex", flexDirection: "column", gap: 8 })}>
          {scan.summary && <p className={style({ font: "body-sm", color: "neutral-subdued", margin: 0 })}>{scan.summary}</p>}
          <ListView aria-label="Findings" selectionMode="single" selectionStyle="highlight" disallowEmptySelection
                    selectedKeys={s.selected >= 0 ? [s.selected] : []}
                    onSelectionChange={(keys) => { const [k] = keys; if (k != null) engine.select(Number(k)) }}
                    styles={style({ maxHeight: "[34vh]" })}>
            {scan.findings.map((f, i) => (
              <ListViewItem key={i} id={i} textValue={f.title}>
                <Text>{i + 1}. {f.title}</Text>
                <Text slot="description">
                  {f.detail}{f.verdict && f.verdict in VERDICT ? ` · ${VERDICT[f.verdict as keyof typeof VERDICT][0]}` : ""}
                </Text>
              </ListViewItem>
            ))}
          </ListView>
          <div className={style({ display: "flex", gap: 8, flexWrap: "wrap" })}>
            {(["critical", "warning", "info"] as const).map((sev) => {
              const n = scan.findings.filter((f) => f.severity === sev).length
              return n > 0 && <StatusLight key={sev} size="S" variant={SEV[sev]}>{n} {sev}</StatusLight>
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const noop = () => () => {}
const initialState: VisionState = {
  camera: null, live: true, status: { tone: "idle", text: "Starting" }, scanning: false,
  frozen: false, scan: null, selected: -1, collapsed: false, trace: null, cameraError: null,
}
const initial = () => initialState
