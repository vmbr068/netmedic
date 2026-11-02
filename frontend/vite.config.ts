import path from "node:path"
import optimizeLocales from "@react-aria/optimize-locales-plugin"
import react from "@vitejs/plugin-react"
import macros from "unplugin-parcel-macros"
import { defineConfig } from "vite"

// Built into the Python package, so `uv run netmedic` serves the UI without Node.
// `npm run dev` proxies the API to a running `netmedic watch`.
export default defineConfig({
  base: "./",  // relative assets: same build served at / and /vision
  plugins: [
    macros.vite(),  // first: compiles Spectrum 2 style() calls to static CSS
    { ...optimizeLocales.vite({ locales: ["en-US", "fr-FR"] }), enforce: "pre" },  // drop the other ~30 translations
    react(),
  ],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  build: {
    target: ["es2022"],
    cssMinify: "lightningcss",
    outDir: "../src/netmedic/web",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: "index.html", vision: "vision.html" },
      output: {
        manualChunks(id) {
          if (/macro-(.*)\.css$/.test(id) || /@react-spectrum\/s2\/.*\.css$/.test(id)) return "s2-styles"
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
})
