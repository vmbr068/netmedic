import "@/lib/large-scale"  // before Spectrum reads the scale
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@react-spectrum/s2/page.css"

import App from "@/dashboard/app"
import "./index.css"

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>)
