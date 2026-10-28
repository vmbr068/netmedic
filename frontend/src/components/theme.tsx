import { AnimatePresence, motion } from "motion/react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")} className="overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={dark ? "moon" : "sun"} initial={{ y: -14, opacity: 0, rotate: -60 }} animate={{ y: 0, opacity: 1, rotate: 0 }}
                     exit={{ y: 14, opacity: 0, rotate: 60 }} transition={{ duration: 0.2 }} className="grid place-items-center">
          {dark ? <Moon /> : <Sun />}
        </motion.span>
      </AnimatePresence>
    </Button>
  )
}
