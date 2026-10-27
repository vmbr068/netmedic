"""Command-line entry point."""

from __future__ import annotations

import asyncio
from enum import Enum

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .agent import Agent
from .config import Inventory, Settings
from .events import Event
from .models import Diagnosis, Remediation
from .pipeline import handle_incident
from .runbooks import load_runbooks
from .ssh import RouterPool
from .tools import Toolbox

app = typer.Typer(no_args_is_help=True, add_completion=False)
console = Console()


class Mode(str, Enum):
    approval = "approval"
    auto = "auto"


_STYLES = {
    "action": "yellow", "committed": "bold green", "rollback": "bold red", "error": "red",
    "decision": "bold", "incident_closed": "bold magenta", "escalate": "bold red",
}


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
    elif event.kind == "diagnosis":
        _print_diagnosis(Diagnosis.model_validate(d))
    elif event.kind == "watch":
        console.print(f"[bold blue]watch[/] {d['text']}")
    elif event.kind == "incident_opened":
        console.rule("[bold magenta]incident opened")
        console.print(d["text"])
    elif event.kind == "check":
        console.print(f"[{'green' if d['ok'] else 'red'}]  {'✓' if d['ok'] else '✗'} {d['text']}[/]")
    elif event.kind in _STYLES:
        console.print(f"[{_STYLES[event.kind]}]{d['text']}[/]")


def _describe(rem: Remediation) -> str:
    actions = "\n".join(f"  • {a.model_dump(exclude={'type'})} [{a.type}]" for a in rem.actions)
    checks = "\n".join(f"  ✓ {c.type} {c.model_dump(exclude={'type'})}" for c in rem.checks)
    return f"[bold]{rem.title}[/] (risk: {rem.risk})\nRoot cause: {rem.root_cause}\n{rem.description}\n\nActions:\n{actions}\n\nVerification:\n{checks}"


def _print_diagnosis(dx: Diagnosis) -> None:
    console.print(Panel(f"[bold]{dx.summary}[/]\n\nRoot cause: {dx.root_cause}\n"
                        f"Affected: {', '.join(dx.affected)}", title="Diagnosis", border_style="green"))
    hyp = Table("Confidence", "Hypothesis", "Evidence", title="Hypotheses")
    for h in dx.hypotheses:
        hyp.add_row(f"{h.confidence:.0%}", h.cause, "\n".join(h.evidence))
    console.print(hyp)
    if not dx.plan:
        console.print("[bold green]No change needed.[/]")
    for i, r in enumerate(dx.plan, 1):
        console.print(Panel(_describe(r), title=f"Plan step {i}/{len(dx.plan)}", border_style="yellow"))
    for r in dx.alternatives:
        console.print(f"[dim]alternative (not applied): {r.title} (risk {r.risk})[/]")


def _setup() -> tuple[Settings, Inventory, RouterPool]:
    settings = Settings.load()
    if not settings.api_key:
        raise SystemExit("no Meta API key: add meta.api_key to secrets.yaml (sops secrets.yaml)")
    inventory = Inventory.load(settings.inventory_path)
    return settings, inventory, RouterPool(inventory)


async def _ask(rem: Remediation) -> bool:
    return await asyncio.to_thread(
        typer.confirm, f"Apply '{rem.title}' (risk {rem.risk})?", default=False
    )


@app.command()
def diagnose(incident: str = typer.Argument(..., help="Incident description or alert text")) -> None:
    """Investigate an incident and print a diagnosis with remediation options (read-only)."""

    async def main() -> None:
        settings, inventory, pool = _setup()
        agent = Agent(settings, inventory, Toolbox(pool), load_runbooks(settings.runbooks_dir), on_event=_render)
        try:
            await agent.investigate(incident)
        finally:
            await pool.close()

    asyncio.run(main())


@app.command()
def fix(
    incident: str = typer.Argument(..., help="Incident description or alert text"),
    mode: Mode = typer.Option(Mode.approval, help="approval: ask before applying; auto: apply low-risk fixes"),
) -> None:
    """Investigate, then safely apply the preferred remediation (with verification and rollback)."""

    async def main() -> None:
        settings, inventory, pool = _setup()
        try:
            await handle_incident(incident, settings, inventory, pool, mode.value, _ask, on_event=_render)
        finally:
            await pool.close()

    asyncio.run(main())


@app.command()
def watch(
    mode: Mode = typer.Option(None, help="Override watch.mode from netmedic.yaml"),
) -> None:
    """Monitor the network continuously; detect, diagnose and fix incidents automatically.
    Also serves the API (POST /api/alerts for external alerts, GET /api/status)."""
    import uvicorn

    from .server import create_app
    from .watcher import Watcher

    async def main() -> None:
        settings, inventory, pool = _setup()
        if mode is not None:
            settings.watch.mode = mode.value
        watcher = Watcher(settings, inventory, pool, _ask, on_event=_render)
        server = uvicorn.Server(uvicorn.Config(
            create_app(watcher), host=settings.server.host, port=settings.server.port, log_level="warning"
        ))
        console.print(f"[bold blue]api[/] http://{settings.server.host}:{settings.server.port} (POST /api/alerts, GET /api/status)")
        try:
            await asyncio.gather(server.serve(), watcher.run())
        finally:
            await pool.close()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass


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
