import { LinkButton, Text } from "@react-spectrum/s2"
import Camera from "@react-spectrum/s2/icons/Camera"
import Path from "@react-spectrum/s2/icons/Path"
import Target from "@react-spectrum/s2/icons/Target"
import { iconStyle, style } from "@react-spectrum/s2/style" with { type: "macro" }

import { Panel } from "@/components/panel"

const FEATURES = [
  { icon: Target, title: "Live ports", text: "SAM 3.1 · empty and plugged" },
  { icon: Camera, title: "Scan", text: "Muse Spark · cross-checked with SAM" },
  { icon: Path, title: "Cable trace", text: "Tap a port" },
]

export function VisionPage() {
  return (
    <div className={style({ maxWidth: 720, width: "full", marginX: "auto" })}>
      <Panel>
        <div className={style({ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, padding: 32, textAlign: "center" })}>
          <Camera styles={iconStyle({ size: "XL", color: "accent" })} />
          <div>
            <h2 className={style({ font: "heading-xl", margin: 0 })}>Rack Vision</h2>
            <p className={style({ font: "body", color: "neutral-subdued", marginTop: 4, marginBottom: 0 })}>Point a phone at a rack.</p>
          </div>
          <div className={style({ display: "grid", gap: 12, width: "full", gridTemplateColumns: { default: ["1fr"], sm: ["1fr", "1fr", "1fr"] } })}>
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className={style({ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 20, borderRadius: "lg", backgroundColor: "layer-1" })}>
                <Icon styles={iconStyle({ size: "L", color: "accent" })} />
                <span className={style({ font: "title-sm" })}>{title}</span>
                <span className={style({ font: "body-xs", color: "neutral-subdued" })}>{text}</span>
              </div>
            ))}
          </div>
          <LinkButton href="./vision" variant="accent" size="L"><Camera /><Text>Open Rack Vision</Text></LinkButton>
        </div>
      </Panel>
    </div>
  )
}
