import { style } from "@react-spectrum/s2/style" with { type: "macro" }

// Spectrum container: a white layer on the gray page, like the panels of Adobe Analytics / Experience Cloud.
const panel = style({
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  backgroundColor: "layer-2",
  borderRadius: "lg",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "gray-200",
  overflow: "hidden",
})

export function Panel({ children, className, styleOverride }: { children: React.ReactNode; className?: string; styleOverride?: React.CSSProperties }) {
  return <section className={panel + (className ? " " + className : "")} style={styleOverride}>{children}</section>
}

export function PanelHeader({ title, description, actions }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className={style({ display: "flex", alignItems: "center", gap: 12, paddingX: 20, paddingTop: 16, paddingBottom: 12 })}>
      <div className={style({ display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 })}>
        <h2 className={style({ font: "title", margin: 0, display: "flex", alignItems: "center", gap: 8 })}>{title}</h2>
        {description && <p className={style({ font: "body-sm", color: "neutral-subdued", margin: 0 })}>{description}</p>}
      </div>
      {actions}
    </header>
  )
}

export const panelBody = style({ paddingX: 20, paddingBottom: 20, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 })
