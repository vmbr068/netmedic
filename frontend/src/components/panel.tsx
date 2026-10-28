import { BorderBeam } from "@/components/ui/border-beam"
import { Card } from "@/components/ui/card"
import { MagicCard } from "@/components/ui/magic-card"
import { cn } from "@/lib/utils"

// Card with a cursor spotlight (Magic UI); `beam` runs a light around the border while something is live.
export function Panel({ className, cardClassName, children, beam }: {
  className?: string; cardClassName?: string; children: React.ReactNode; beam?: boolean
}) {
  return (
    <MagicCard className={cn("rounded-2xl shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.08)] dark:shadow-none", className)}
               gradientSize={300} gradientColor="var(--spotlight)" gradientOpacity={0.9} gradientFrom="var(--info)" gradientTo="var(--violet)">
      <Card className={cn("h-full rounded-2xl bg-transparent ring-0 [--card-spacing:--spacing(5)]", cardClassName)}>{children}</Card>
      {beam && <BorderBeam size={160} duration={4.5} borderWidth={1.5} colorFrom="var(--info)" colorTo="var(--violet)" />}
    </MagicCard>
  )
}
