import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Built into the Python package, so `uv run netmedic` serves the UI without Node.
// `npm run dev` proxies the API to a running `netmedic watch`.
export default defineConfig({
  base: "./",  // relative assets: same build served at / and /vision
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: "../src/netmedic/web",
    emptyOutDir: true,
    rollupOptions: { input: { index: "index.html", vision: "vision.html" } },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
})
