import { Camera, ScanLine, Spline, Smartphone } from "lucide-react"

import { Panel } from "@/components/panel"
import { CardContent } from "@/components/ui/card"
import { ShimmerButton } from "@/components/ui/shimmer-button"

const FEATURES = [
  { icon: ScanLine, title: "Live ports", text: "SAM 3.1 · empty and plugged" },
  { icon: Camera, title: "Scan", text: "Muse Spark · cross-checked with SAM" },
  { icon: Spline, title: "Cable trace", text: "Tap a port" },
]

export function VisionPage() {
  return (
    <Panel className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center gap-6 py-6 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-brand text-white shadow-lg shadow-primary/30"><Camera className="size-6" /></span>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Rack <span className="text-brand">Vision</span></h2>
          <p className="mt-1 text-sm text-muted-foreground">Point a phone at a rack.</p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex flex-col items-center gap-1.5 rounded-2xl border bg-background/50 p-5 transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
              <span className="grid size-9 place-items-center rounded-full bg-primary/10 text-primary"><Icon className="size-4" /></span>
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">{text}</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col items-center gap-2">
          <a href="./vision">
            <ShimmerButton className="gap-2 px-5 py-2.5 text-sm font-medium" shimmerDuration="2.5s"><Camera className="size-4" />Open</ShimmerButton>
          </a>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Smartphone className="size-3.5" />
            <code className="font-mono">netmedic watch --lan</code>
          </p>
        </div>
      </CardContent>
    </Panel>
  )
}
