import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"

import VisionApp from "./app"
import "../index.css"

createRoot(document.getElementById("root")!).render(<StrictMode><ThemeProvider attribute="class" defaultTheme="system" enableSystem><VisionApp /></ThemeProvider></StrictMode>)
