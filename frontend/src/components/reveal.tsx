import { useReducedMotion } from "motion/react"

import { BlurFade } from "@/components/ui/blur-fade"

// Blur-in on mount (Magic UI), skipped entirely when the system asks for reduced motion.
export function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return <BlurFade delay={delay} duration={0.45} offset={8} direction="up" blur="8px" className={className}>{children}</BlurFade>
}
