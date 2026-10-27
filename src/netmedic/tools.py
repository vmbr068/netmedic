"""Read-only diagnostic tools exposed to the model.

Every tool validates its arguments and maps them to a fixed argv: the model can never run
arbitrary commands on a router.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .ssh import RouterPool

_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


class ToolError(ValueError):
    pass


def _name(value: str, what: str) -> str:
    if not _NAME.match(value):
        raise ToolError(f"invalid {what}: {value!r}")
    return value


def _target(value: str) -> str:
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if _HOST.match(value) and not value.startswith("-"):
            return value
    raise ToolError(f"invalid target: {value!r}")


def _prefix(value: str) -> str:
    try:
        return str(ipaddress.ip_network(value, strict=False))
    except ValueError as e:
        raise ToolError(f"invalid prefix: {value!r}") from e


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    build: Callable[[dict[str, Any]], list[str]]

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }


def _params(**props: dict[str, Any]) -> dict[str, Any]:
    required = [k for k, v in props.items() if not v.pop("optional", False)]
    return {
        "type": "object",
        "properties": {"router": {"type": "string", "description": "Router name from the inventory"}, **props},
        "required": ["router", *required],
        "additionalProperties": False,
    }


_STR = {"type": "string"}
_INT = {"type": "integer"}

DIAGNOSTIC_TOOLS: list[Tool] = [
    Tool(
        "bird_protocols",
        "List all BIRD protocols (BGP sessions, static, kernel, device) and their state.",
        _params(),
        lambda a: ["birdc", "show", "protocols"],
    ),
    Tool(
        "bird_protocol_detail",
        "Detailed state of one BIRD protocol: BGP state, last error, neighbor address/AS, "
        "hold timers, imported/exported route counts.",
        _params(protocol={**_STR, "description": "Protocol name, e.g. bgp_r2"}),
        lambda a: ["birdc", "show", "protocols", "all", _name(a["protocol"], "protocol")],
    ),
    Tool(
        "bird_routes",
        "Show BIRD routing table, optionally filtered to one prefix (longest match) or one protocol.",
        _params(
            prefix={**_STR, "description": "CIDR prefix to look up", "optional": True},
            protocol={**_STR, "description": "Only routes from this protocol", "optional": True},
        ),
        lambda a: ["birdc", "show", "route"]
        + (["for", _prefix(a["prefix"])] if a.get("prefix") else [])
        + (["protocol", _name(a["protocol"], "protocol")] if a.get("protocol") else [])
        + ["all"],
    ),
    Tool(
        "bird_config",
        "Read the BIRD configuration files actually loaded on the router (base + agent-managed includes).",
        _params(),
        lambda a: ["sh", "-c", "cat /etc/bird/bird.conf 2>/dev/null; "
                   "for f in /var/lib/netagent/*.conf; do [ -e \"$f\" ] && echo \"### $f\" && cat \"$f\"; done"],
    ),
    Tool(
        "bird_logs",
        "Recent BIRD daemon logs from journald.",
        _params(lines={**_INT, "description": "Number of lines (default 80, max 300)", "optional": True}),
        lambda a: ["journalctl", "-u", "bird", "--no-pager", "-o", "short-iso",
                   "-n", str(min(int(a.get("lines") or 80), 300))],
    ),
    Tool(
        "interfaces",
        "Interface state, MTU and addresses (ip -br link + ip addr).",
        _params(),
        lambda a: ["sh", "-c", "ip -br link; echo; ip -br addr; echo; ip -d link | grep -E '^[0-9]+:|mtu'"],
    ),
    Tool(
        "kernel_routes",
        "Kernel routing table (ip route), IPv4 and IPv6.",
        _params(),
        lambda a: ["sh", "-c", "ip -4 route; echo; ip -6 route"],
    ),
    Tool(
        "ping",
        "Ping a target from the router. Optionally set packet size (with DF bit) to test MTU.",
        _params(
            target={**_STR, "description": "IP or hostname"},
            size={**_INT, "description": "Payload size in bytes, sets DF (MTU test)", "optional": True},
        ),
        lambda a: ["ping", "-c", "3", "-W", "1", "-i", "0.3"]
        + (["-M", "do", "-s", str(min(max(int(a["size"]), 16), 9000))] if a.get("size") else [])
        + [_target(a["target"])],
    ),
    Tool(
        "traceroute",
        "Traceroute (numeric) from the router to a target.",
        _params(target={**_STR, "description": "IP or hostname"}),
        lambda a: ["traceroute", "-I", "-n", "-w", "1", "-q", "1", "-m", "15", _target(a["target"])],
    ),
    Tool(
        "tcp_check",
        "Check TCP reachability of a port on a target (e.g. 179 for BGP, 53 for DNS).",
        _params(target={**_STR, "description": "IP or hostname"}, port=_INT),
        lambda a: ["sh", "-c", 'timeout 3 bash -c "</dev/tcp/$0/$1" && echo OPEN || echo CLOSED',
                   _target(a["target"]), str(int(a["port"]))],
    ),
    Tool(
        "dns_lookup",
        "Resolve a name using the router's resolver, or a specific DNS server.",
        _params(
            name={**_STR, "description": "Name to resolve"},
            server={**_STR, "description": "DNS server IP", "optional": True},
        ),
        lambda a: ["dig", "+time=2", "+tries=1", _target(a["name"])]
        + ([f"@{_target(a['server'])}"] if a.get("server") else []),
    ),
    Tool(
        "firewall_rules",
        "Current nftables ruleset with rule handles (to spot dropped BGP/ICMP/DNS traffic).",
        _params(),
        lambda a: ["nft", "-a", "list", "ruleset"],
    ),
]


class Toolbox:
    def __init__(self, pool: RouterPool, tools: list[Tool] | None = None):
        self.pool = pool
        self.tools = {t.name: t for t in (tools or DIAGNOSTIC_TOOLS)}

    def schemas(self) -> list[dict[str, Any]]:
        return [t.schema() for t in self.tools.values()]

    async def call(self, name: str, args: dict[str, Any]) -> str:
        tool = self.tools.get(name)
        if tool is None:
            return f"error: unknown tool {name!r}"
        router = args.get("router", "")
        if router not in self.pool.inventory.routers:
            return f"error: unknown router {router!r}; known: {', '.join(self.pool.inventory.routers)}"
        try:
            argv = tool.build(args)
        except (ToolError, KeyError, TypeError, ValueError) as e:
            return f"error: {e}"
        result = await self.pool.run(router, argv)
        return result.as_text()


