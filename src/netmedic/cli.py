"""Command-line entry point."""

from __future__ import annotations

import asyncio

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .agent import Agent, Event
from .config import Inventory, Settings
from .models import Diagnosis
from .runbooks import load_runbooks
from .ssh import RouterPool
from .tools import Toolbox

app = typer.Typer(no_args_is_help=True, add_completion=False)
console = Console()


async def _render(event: Event) -> None:
    d = event.data
    if event.kind == "thinking":
        console.print(f"[italic dim]{d['text']}[/]")
    elif event.kind == "tool_call":
        args = ", ".join(f"{k}={v}" for k, v in d["args"].items())
        console.print(f"[cyan]→ {d['name']}[/]({args})")
    elif event.kind == "tool_result":
        first = d["output"].splitlines()[1] if "\n" in d["output"] else d["output"]
        console.print(f"  [dim]{first}[/]")
    elif event.kind == "error":
        console.print(f"[red]{d['text']}[/]")


def _print_diagnosis(dx: Diagnosis) -> None:
    console.print(Panel(f"[bold]{dx.summary}[/]\n\nRoot cause: {dx.root_cause}\n"
                        f"Affected: {', '.join(dx.affected)}", title="Diagnosis", border_style="green"))
    hyp = Table("Confidence", "Hypothesis", "Evidence", title="Hypotheses")
    for h in dx.hypotheses:
        hyp.add_row(f"{h.confidence:.0%}", h.cause, "\n".join(h.evidence))
    console.print(hyp)
    rem = Table("#", "Risk", "Router", "Remediation", "Rollback", title="Remediation options")
    for i, r in enumerate(dx.remediations, 1):
        rem.add_row(str(i), r.risk, r.router, f"[bold]{r.title}[/]\n{r.description}", r.rollback)
    console.print(rem)


@app.command()
def diagnose(incident: str = typer.Argument(..., help="Incident description or alert text")) -> None:
    """Investigate an incident and print a diagnosis with remediation options."""

    async def main() -> None:
        settings = Settings.load()
        if not settings.api_key:
            raise SystemExit("no Meta API key: add meta.api_key to secrets.yaml (sops secrets.yaml)")
        inventory = Inventory.load(settings.inventory_path)
        pool = RouterPool(inventory)
        agent = Agent(settings, inventory, Toolbox(pool), load_runbooks(settings.runbooks_dir), on_event=_render)
        try:
            _print_diagnosis(await agent.investigate(incident))
        finally:
            await pool.close()

    asyncio.run(main())


@app.command()
def status() -> None:
    """Show BIRD protocol state on every router."""

    async def main() -> None:
        settings = Settings.load(with_secrets=False)
        pool = RouterPool(Inventory.load(settings.inventory_path))
        results = await asyncio.gather(
            *(pool.run(name, ["birdc", "show", "protocols"]) for name in pool.inventory.routers)
        )
        for res in results:
            console.print(Panel(res.stdout or res.stderr, title=res.router))
        await pool.close()

    asyncio.run(main())


if __name__ == "__main__":
    app()
