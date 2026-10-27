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
    "approval_request": "bold yellow", "approval_resolved": "bold", "model": "dim cyan",
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
def diagnose(
    incident: str = typer.Argument(..., help="Incident description or alert text"),
    tier: int = typer.Option(0, help="Model tier from netmedic.yaml (0 = fastest)"),
) -> None:
    """Investigate an incident and print a diagnosis with remediation options (read-only)."""

    async def main() -> None:
        settings, inventory, pool = _setup()
        agent = Agent(settings, inventory, Toolbox(pool), load_runbooks(settings.runbooks_dir), on_event=_render, tier=tier)
        try:
            await agent.investigate(incident)
        finally:
            await pool.close()

    asyncio.run(main())


@app.command()
def fix(
    incident: str = typer.Argument(..., help="Incident description or alert text"),
    mode: Mode = typer.Option(Mode.approval, help="approval: ask before applying; auto: apply low-risk fixes"),
    tier: int = typer.Option(0, help="Model tier from netmedic.yaml (0 = fastest)"),
) -> None:
    """Investigate, then safely apply the preferred remediation (with verification and rollback)."""

    async def main() -> None:
        settings, inventory, pool = _setup()
        try:
            await handle_incident(incident, settings, inventory, pool, mode.value, _ask, on_event=_render, tier=tier)
        finally:
            await pool.close()

    asyncio.run(main())


@app.command()
def watch(
    mode: Mode = typer.Option(None, help="Override watch.mode from netmedic.yaml"),
    lan: bool = typer.Option(False, help="Serve on the LAN over HTTPS with an access token (for the phone)"),
) -> None:
    """Monitor the network continuously; detect, diagnose and fix incidents automatically.
    Serves the web UI and the API (POST /api/alerts, GET /api/status, GET /api/events)."""
    import secrets as pysecrets

    import uvicorn

    from .approvals import ApprovalBroker
    from .config import load_secrets
    from .hub import EventHub
    from .server import create_app
    from .watcher import Watcher

    async def main() -> None:
        settings, inventory, pool = _setup()
        if mode is not None:
            settings.watch.mode = mode.value
        hub = EventHub()

        async def sink(event: Event) -> None:
            await hub.publish(event)
            await _render(event)

        broker = ApprovalBroker(on_event=sink)
        watcher = Watcher(settings, inventory, pool, broker, on_event=sink)

        host, port, token, ssl, ca = settings.server.host, settings.server.port, None, {}, None
        if lan:
            from .tls import ensure_ca, lan_addresses, server_cert

            addrs = lan_addresses()
            if not addrs:
                raise SystemExit("no LAN address found")
            ca, _ = ensure_ca()
            cert, key = server_cert(addrs)
            host, ssl = "0.0.0.0", {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}
            token = load_secrets().get("server", {}).get("token") or pysecrets.token_urlsafe(18)

        server = uvicorn.Server(uvicorn.Config(
            create_app(watcher, hub, broker, token=token, ca_cert=ca),
            host=host, port=port, log_level="warning", **ssl,
        ))
        if lan:
            import segno

            url = f"https://{addrs[0]}:{port}/?token={token}"
            console.print(f"[bold blue]web[/] {url}")
            console.print(f"[dim]first time on the phone: open https://{addrs[0]}:{port}/ca.crt, "
                          "install the profile, then trust it in Settings > General > About > "
                          "Certificate Trust Settings[/]")
            segno.make(url, error="m").terminal(compact=True)
        else:
            console.print(f"[bold blue]web[/] http://{host}:{port}  (approvals happen in the web UI)")
        try:
            await asyncio.gather(server.serve(), watcher.run())
        finally:
            await pool.close()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass


@app.command("eval")
def evaluate(
    runs: int = typer.Option(3, help="Runs per scenario"),
    scenario: list[str] = typer.Option(None, help="Scenario(s) to run (default: all)"),
    budget: float = typer.Option(300, help="Seconds allowed per run to get back to healthy"),
) -> None:
    """Replay chaos scenarios through the real watcher (auto mode) and measure success and MTTR."""
    from .evaluate import default_scenarios, render_markdown, run_one, save, summarize

    async def main() -> None:
        settings, inventory, pool = _setup()
        results = []
        try:
            for name in scenario or default_scenarios():
                for i in range(1, runs + 1):
                    console.print(f"[bold]{name}[/] run {i}/{runs} …", end=" ")
                    r = await run_one(settings, inventory, pool, name, i, budget)
                    results.append(r)
                    console.print(
                        f"[green]resolved in {r.resolve_s}s[/] (detect {r.detect_s}s, {r.incidents} incident(s), "
                        f"{r.tool_calls} tool calls)" if r.success else f"[red]FAILED[/] {r.error} {r.statuses}"
                    )
        finally:
            await pool.close()
            await asyncio.create_subprocess_exec("lab/chaos.sh", "reset")
        rows = summarize(results)
        markdown = render_markdown(rows, results, settings.model)
        console.print(markdown)
        console.print(f"Saved: {save(results, rows, markdown)}")

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
