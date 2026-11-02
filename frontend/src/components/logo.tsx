import { style } from "@react-spectrum/s2/style" with { type: "macro" }

// Black tile with a white pulse line. Its own module so the phone page does not pull in the dashboard.
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={style({ flexShrink: 0 })}>
      <rect width={32} height={32} rx={8} fill="black" />
      <path d="M6 16h5l3-7 4 14 3-7h5" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
