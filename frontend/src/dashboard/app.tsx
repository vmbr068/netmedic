import { useEffect, useState } from "react"
import {
  ActionButton, Button, ButtonGroup, Content, Dialog, DialogTrigger, Heading, Menu, MenuItem, MenuTrigger, Provider,
  SegmentedControl, SegmentedControlItem, SideNav, SideNavItem, SideNavItemContent, SideNavItemLink, Text,
  TextArea, ToastContainer, ToastQueue, Tooltip, TooltipTrigger,
} from "@react-spectrum/s2"
import Camera from "@react-spectrum/s2/icons/Camera"
import Contrast from "@react-spectrum/s2/icons/Contrast"
import DeviceDesktop from "@react-spectrum/s2/icons/DeviceDesktop"
import FileText from "@react-spectrum/s2/icons/FileText"
import GlobeGrid from "@react-spectrum/s2/icons/GlobeGrid"
import Home from "@react-spectrum/s2/icons/Home"
import MenuHamburger from "@react-spectrum/s2/icons/MenuHamburger"
import Send from "@react-spectrum/s2/icons/Send"
import { style } from "@react-spectrum/s2/style" with { type: "macro" }

import { api } from "@/lib/api"
import { useColorScheme } from "@/lib/color-scheme"
import { useNetmedic } from "@/lib/use-netmedic"

import { DevicesPage } from "./devices"
import { IncidentsPage } from "./incidents"
import { OverviewPage } from "./overview"
import { TopologyPage } from "./topology"
import { VisionPage } from "./vision"

const PAGES = {
  overview: { title: "Overview", icon: Home },
  topology: { title: "Topology", icon: GlobeGrid },
  devices: { title: "Devices", icon: DeviceDesktop },
  incidents: { title: "Incidents", icon: FileText },
  vision: { title: "Rack Vision", icon: Camera },
} as const
export type Page = keyof typeof PAGES
export type Go = (p: Page, sub?: string) => void

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
  const [scheme, toggleScheme] = useColorScheme()
  return (
    <Provider background="layer-1" colorScheme={scheme} styles={style({ minHeight: "screen" })}>
      <Shell toggleScheme={toggleScheme} />
      <ToastContainer placement="bottom end" />
    </Provider>
  )
}

// Black tile with a white pulse line.
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={style({ flexShrink: 0 })}>
      <rect width={32} height={32} rx={8} fill="black" />
      <path d="M6 16h5l3-7 4 14 3-7h5" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const shell = style({
  display: "grid",
  gridTemplateColumns: { default: ["1fr"], md: [240, "1fr"] },
  gridTemplateRows: [56, "1fr"],
  gridTemplateAreas: { default: ["top", "main"], md: ["top top", "nav main"] },
  minHeight: "screen",
})

function Shell({ toggleScheme }: { toggleScheme: () => void }) {
  const nm = useNetmedic()
  const [page, sub, go] = useRoute()
  const open = (name: string) => go("topology", name)

  return (
    <div className={shell}>
      <header className={style({
        gridArea: "top", position: "sticky", top: 0, zIndex: 3, display: "flex", alignItems: "center", gap: 12, paddingX: 16,
        backgroundColor: "layer-2", borderWidth: 0, borderBottomWidth: 1, borderStyle: "solid", borderColor: "gray-200",
      })}>
        <div className={style({ display: { default: "block", md: "none" } })}><MobileNav go={go} /></div>
        <a href="#overview" className={style({ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" })}>
          <Logo size={28} />
          <span className={style({ font: "title-lg", fontWeight: "black", color: "heading" })}>netmedic</span>
        </a>
        <div className={style({ marginStart: "auto", display: "flex", alignItems: "center", gap: 12 })}>
          {nm.snapshot && <ModeSwitch mode={nm.snapshot.mode} />}
          <ReportIssue />
          <TooltipTrigger>
            <ActionButton isQuiet aria-label="Toggle color scheme" onPress={toggleScheme}><Contrast /></ActionButton>
            <Tooltip>Light / dark</Tooltip>
          </TooltipTrigger>
        </div>
      </header>

      <nav className={style({
        gridArea: "nav", display: { default: "none", md: "flex" }, flexDirection: "column", gap: 8, padding: 12,
        position: "sticky", top: 56, height: "[calc(100vh - 56px)]", boxSizing: "border-box",
      })}>
        <SideNav aria-label="Pages" selectedRoute={`#${page}`} styles={style({ flexGrow: 1 })}>
          {(Object.keys(PAGES) as Page[]).map((p) => {
            const { title, icon: Icon } = PAGES[p]
            return (
              <SideNavItem key={p} id={p} href={`#${p}`} textValue={title}>
                <SideNavItemContent>
                  <Icon />
                  <SideNavItemLink>{title}</SideNavItemLink>
                </SideNavItemContent>
              </SideNavItem>
            )
          })}
        </SideNav>
      </nav>

      <main className={style({ gridArea: "main", minWidth: 0, padding: { default: 16, md: 24 }, display: "flex", flexDirection: "column", gap: 16 })}>
        <h1 className={style({ font: "heading-lg", margin: 0 })}>{PAGES[page].title}</h1>
        {page === "overview" && <OverviewPage nm={nm} onDevice={open} go={go} />}
        {page === "topology" && <TopologyPage nm={nm} selected={sub} onSelect={open} />}
        {page === "devices" && <DevicesPage nm={nm} onDevice={open} />}
        {page === "incidents" && <IncidentsPage nm={nm} report={sub} onReport={(name) => go("incidents", name)} />}
        {page === "vision" && <VisionPage />}
      </main>
    </div>
  )
}

function MobileNav({ go }: { go: Go }) {
  return (
    <MenuTrigger>
      <ActionButton isQuiet aria-label="Pages"><MenuHamburger /></ActionButton>
      <Menu onAction={(k) => go(k as Page)}>
        {(Object.keys(PAGES) as Page[]).map((p) => {
          const { title, icon: Icon } = PAGES[p]
          return <MenuItem key={p} id={p} textValue={title}><Icon /><Text slot="label">{title}</Text></MenuItem>
        })}
      </Menu>
    </MenuTrigger>
  )
}

function ModeSwitch({ mode }: { mode: string }) {
  const [value, setValue] = useState(mode)
  useEffect(() => setValue(mode), [mode])
  const choose = async (v: string) => {
    if (v === value) return
    setValue(v)
    try { await api.setMode(v); ToastQueue.info(v === "auto" ? "Auto remediation" : "Approval required for every fix", { timeout: 4000 }) }
    catch (e) { ToastQueue.negative(String(e), { timeout: 6000 }); setValue(mode) }
  }
  return (
    <div className={style({ display: { default: "none", md: "block" } })}>
      <SegmentedControl aria-label="Remediation mode" selectedKey={value} onSelectionChange={(k) => choose(String(k))}>
        <SegmentedControlItem id="auto">Auto</SegmentedControlItem>
        <SegmentedControlItem id="approval">Approval</SegmentedControlItem>
      </SegmentedControl>
    </div>
  )
}

function ReportIssue() {
  const [text, setText] = useState("")
  const submit = async (close: () => void) => {
    if (!text.trim()) return
    try { await api.alert(text.trim()); ToastQueue.positive("Issue reported", { timeout: 4000 }); setText(""); close() }
    catch (e) { ToastQueue.negative(String(e), { timeout: 6000 }) }
  }
  return (
    <DialogTrigger>
      <Button variant="secondary" fillStyle="outline"><Send /><Text>Report</Text></Button>
      <Dialog size="M" isDismissible>
        {({ close }) => (
          <>
            <Heading slot="title">Report an issue</Heading>
            <Content>
              <TextArea autoFocus label="What is wrong?" value={text} onChange={setText} placeholder="app.lab unreachable from branch1"
                        styles={style({ width: "full" })}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(close); else e.continuePropagation() }} />
            </Content>
            <ButtonGroup>
              <Button variant="secondary" onPress={close}>Cancel</Button>
              <Button variant="accent" onPress={() => submit(close)} isDisabled={!text.trim()}>Send</Button>
            </ButtonGroup>
          </>
        )}
      </Dialog>
    </DialogTrigger>
  )
}
