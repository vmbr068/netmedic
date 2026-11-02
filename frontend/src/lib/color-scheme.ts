import { useEffect, useState } from "react"

export type Scheme = "light" | "dark"

const read = (): Scheme | null => {
  try { const v = localStorage.getItem("color-scheme"); return v === "light" || v === "dark" ? v : null } catch { return null }
}
const system = (): Scheme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")

// Explicit choice wins, otherwise follow the OS. Mirrored on <html> so Spectrum's page.css paints the page background too.
export function useColorScheme(): [Scheme, () => void] {
  const [chosen, setChosen] = useState(read)
  const [os, setOs] = useState(system)
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)")
    const on = () => setOs(system())
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  const scheme = chosen ?? os
  useEffect(() => { document.documentElement.dataset.colorScheme = scheme }, [scheme])
  const toggle = () => {
    const next = scheme === "dark" ? "light" : "dark"
    try { localStorage.setItem("color-scheme", next) } catch { /* private mode */ }
    setChosen(next)
  }
  return [scheme, toggle]
}
