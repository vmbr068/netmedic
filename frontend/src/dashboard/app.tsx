import { useEffect, useState } from "react"
import { MotionConfig, motion } from "motion/react"
import { Activity, Camera, FileText, LayoutDashboard, Network, Send, Server } from "lucide-react"
import { ThemeProvider } from "next-themes"
import { toast } from "sonner"

import { Reveal } from "@/components/reveal"
import { Dot } from "@/components/status"
import { ThemeToggle } from "@/components/theme"
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { api, type Snapshot } from "@/lib/api"
import type { Tone } from "@/lib/incident"
import { useNetmedic, type Connection } from "@/lib/use-netmedic"
import { cn } from "@/lib/utils"

import { DevicesPage } from "./devices"
import { IncidentsPage } from "./incidents"
import { OverviewPage } from "./overview"
import { TopologyPage } from "./topology"
import { VisionPage } from "./vision"

const PAGES = {
  overview: { title: "Overview", icon: LayoutDashboard },
  topology: { title: "Topology", icon: Network },
  devices: { title: "Devices", icon: Server },
  incidents: { title: "Incidents", icon: FileText },
  vision: { title: "Rack Vision", icon: Camera },
} as const
export type Page = keyof typeof PAGES
export type Go = (p: Page, sub?: string) => void

const SPRING = { type: "spring", stiffness: 420, damping: 34 } as const

// Pages live in the URL hash (#incidents/<report>), so a reload or a shared link keeps the view.
function useRoute(): [Page, string, Go] {
  const read = (): [Page, string] => {
    const [p, sub = ""] = location.hash.slice(1).split("/")
    return [p in PAGES ? (p as Page) : "overview", decodeURIComponent(sub)]
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return [route[0], route[1], (p, sub) => { location.hash = sub ? `${p}/${encodeURIComponent(sub)}` : p }]
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <Shell />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-8 place-items-center rounded-xl bg-brand text-white shadow-sm shadow-primary/30", className)}>
      <Activity className="size-4" strokeWidth={2.5} />
    </span>
  )
}

function Shell() {
  const nm = useNetmedic()
  const [page, sub, go] = useRoute()
  const open = (name: string) => go("topology", name)

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="pointer-events-none">
                <Logo />
                <span className="text-[15px] font-semibold tracking-tight">netmedic</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {(Object.keys(PAGES) as Page[]).map((p) => {
                  const { title, icon: Icon } = PAGES[p]
                  const active = page === p
                  return (
                    <SidebarMenuItem key={p}>
                      <SidebarMenuButton isActive={active} tooltip={title} onClick={() => go(p)}
                        className="relative isolate rounded-full data-[active=true]:bg-transparent data-[active=true]:text-primary">
                        {active && <motion.span layoutId="nav-active" transition={SPRING}
                                                className="absolute inset-0 -z-10 rounded-full bg-primary/10 dark:bg-primary/15" />}
                        <Icon />
                        <span>{title}</span>
                      </SidebarMenuButton>
                      {p === "overview" && nm.incident.active && <SidebarMenuBadge><Dot tone="bad" pulse /></SidebarMenuBadge>}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <ConnectionState connection={nm.connection} />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="relative overflow-hidden">
        <Glow />
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 px-4 md:px-6">
          <SidebarTrigger className="-ml-1 rounded-full" />
          <Separator orientation="vertical" className="h-4!" />
          <motion.h1 key={page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
                     className="text-lg font-semibold tracking-tight">{PAGES[page].title}</motion.h1>
          <div className="ml-auto flex items-center gap-2">
            {nm.snapshot && <NetworkState s={nm.snapshot} />}
            {nm.snapshot && <ModeSwitch mode={nm.snapshot.mode} />}
            <ReportIssue />
            <ThemeToggle />
          </div>
        </header>
        <main className="relative z-10 flex-1 px-4 pb-6 md:px-6">
          <Reveal key={page}>
            {page === "overview" && <OverviewPage nm={nm} onDevice={open} go={go} />}
            {page === "topology" && <TopologyPage nm={nm} selected={sub} onSelect={open} />}
            {page === "devices" && <DevicesPage nm={nm} onDevice={open} />}
            {page === "incidents" && <IncidentsPage nm={nm} report={sub} onReport={(name) => go("incidents", name)} />}
            {page === "vision" && <VisionPage />}
          </Reveal>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

// Soft drifting light behind the page, the way meta.com washes its heroes in blue and violet.
function Glow() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px] overflow-hidden">
      <div className="animate-aurora absolute -top-56 left-[8%] size-[640px] rounded-full bg-[var(--glow-a)] blur-[110px]" />
      <div className="animate-aurora absolute -top-64 right-[2%] size-[560px] rounded-full bg-[var(--glow-b)] blur-[120px] [animation-delay:-8s]" />
    </div>
  )
}

function ConnectionState({ connection }: { connection: Connection }) {
  const [tone, text]: [Tone, string] =
    connection === "live" ? ["ok", "Connected"] : connection === "lost" ? ["bad", "Reconnecting"] : ["warn", "Connecting"]
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center">
      <Dot tone={tone} pulse={connection === "live"} />
      <span className="group-data-[collapsible=icon]:hidden">{text}</span>
    </div>
  )
}

function networkState(s: Snapshot): [Tone, string, boolean] {
  if (s.busy) return ["info", "Remediating", true]
  if (!s.symptoms.length) return ["ok", s.baseline_learned ? "Healthy" : "Learning", false]
  if (s.settling) return ["warn", "Reconverging", true]
  if (s.symptoms.every((x) => x.acknowledged)) return ["warn", "Escalated", false]
  return ["bad", `${s.symptoms.length} issue${s.symptoms.length > 1 ? "s" : ""}`, true]
}

function NetworkState({ s }: { s: Snapshot }) {
  const [tone, text, pulse] = networkState(s)
  return (
    <motion.span layout className="hidden items-center gap-2 rounded-full border bg-card/70 px-3 py-1.5 text-xs font-medium backdrop-blur sm:inline-flex">
      <Dot tone={tone} pulse={pulse} />
      {s.busy ? <AnimatedShinyText className="mx-0 text-foreground/70" shimmerWidth={60}>{text}</AnimatedShinyText> : text}
    </motion.span>
  )
}

// Segmented control with a sliding pill.
function ModeSwitch({ mode }: { mode: string }) {
  const [value, setValue] = useState(mode)
  useEffect(() => setValue(mode), [mode])
  const choose = async (v: string) => {
    if (v === value) return
    setValue(v)
    try { await api.setMode(v); toast(v === "auto" ? "Auto remediation" : "Approval required for every fix") }
    catch (e) { toast.error(String(e)); setValue(mode) }
  }
  return (
    <div className="relative hidden rounded-full border bg-card/70 p-0.5 backdrop-blur md:flex" role="radiogroup" aria-label="Remediation mode">
      {(["auto", "approval"] as const).map((v) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => choose(v)}
          className={cn("relative z-10 rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors",
            value === v ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
          {value === v && <motion.span layoutId="mode-pill" transition={SPRING} className="absolute inset-0 -z-10 rounded-full bg-primary" />}
          {v}
        </button>
      ))}
    </div>
  )
}

function ReportIssue() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const submit = async () => {
    if (!text.trim()) return
    try { await api.alert(text.trim()); toast.success("Issue reported"); setText(""); setOpen(false) }
    catch (e) { toast.error(String(e)) }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="bg-card/70 backdrop-blur"><Send />Report</Button>
      </DialogTrigger>
      <DialogContent className="rounded-2xl sm:max-w-md">
        <DialogHeader><DialogTitle>Report an issue</DialogTitle></DialogHeader>
        <Textarea autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)} className="rounded-xl"
                  placeholder="app.lab unreachable from branch1"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit() }} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!text.trim()}>Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
