# The lab

netmedic is developed and evaluated against real routing software: BIRD 3 on NixOS, one QEMU VM per
router, started without root by `lab/lab.sh`. The links are point-to-point UDP sockets between the
VMs, so the guests see real interfaces, real carrier and real MTUs.

## Topologies

`lab/lab.sh use <topology>` selects one and regenerates `inventory.yaml` for netmedic.

### enterprise (8 VMs) — the demo network

```
    isp1 (AS64501) ════════ isp2 (AS64502)      transit providers, NOT managed by netmedic
        │ eBGP primary          │ eBGP backup
      edge1 ─────────┐   ┌───── edge2           border routers, AS65000
        │  ╲          ╳          ╱ │
      core1 ═════════════════ core2             OSPF area 0 + iBGP route reflectors
        │   ╲                 ╱    │
       dc1 (DNS + web app)  branch1 (AS65010)   datacenter (RR client) / branch office (eBGP)
```

- OSPF carries infrastructure loopbacks only; customer prefixes are carried by BGP.
- iBGP over loopbacks with core1/core2 as route reflectors; edges set `next hop self`.
- isp1 is the primary upstream (local-pref 200), isp2 the backup (local-pref 100).
- dc1 hosts DNS (unbound) and the web app `app.lab` (nginx).

The redundancy is deliberate: most faults are *hidden* (traffic reroutes, sessions stay up) and
only show as best-path drift or a lost adjacency.

### ring (4 VMs)

Four routers r1–r4 in a ring, one AS each, eBGP between neighbours, DNS on r4. Simpler, kept as a
fallback demo topology.

## Chaos scenarios

`lab/chaos.sh list` shows the scenarios of the current topology, `lab/chaos.sh <name>` injects one,
`lab/chaos.sh reset` restores the baseline on every router (and plugs pulled cables back in).

| enterprise | What breaks |
|---|---|
| `ospf-mtu` | core2 to-dc1 MTU 1400 → OSPF stuck in ExStart, hidden by redundancy |
| `nexthop-self` | `next hop self` removed on edge1 → isp1 routes unresolvable, silent failover to the backup |
| `rr-client` | every `rr client` dropped on both route reflectors → nothing reflected, dc1 loses the internet |
| `branch-limit` | import limit 2 on the branch session → *route limit exceeded*, session disabled |
| `failover-broken` | isp1 outage (provider side) + latent typo in edge2's upstream filter → internet down |
| `dns-service` | unbound stopped on dc1 → names stop resolving everywhere |
| `dns-firewall` | nftables rule drops DNS on dc1 |
| `meltdown` | failover-broken + ospf-mtu + branch-limit at once |
| `cable-unplug` | *physical*: the edge1 ↔ core1 patch cord is pulled → NO-CARRIER on both ends, Rack Vision |

| ring | What breaks |
|---|---|
| `bgp-peer-as` | wrong remote AS on r2 → *Bad peer AS* |
| `prefix-filter` | typo'd import prefix list on r1 → session up, 0 routes |
| `link-down` | r3 to-r4 administratively down |
| `dns-firewall`, `dns-service` | DNS blocked or stopped on r4 |
| `meltdown` | bgp-peer-as + link-down + dns-service at once |
| `cable-unplug` | *physical*: the r3 ↔ r4 patch cord is pulled |

Physical scenarios need a human and are excluded from `netmedic eval`.

## Commands

```sh
lab/lab.sh use enterprise          # or ring
lab/lab.sh up | down | ps | status # VMs, BGP/OSPF summary
lab/lab.sh ssh core1 "birdc show protocols"
lab/lab.sh cable edge1 to-core1 off   # pull / re-plug a virtual cable (QMP set_link)
```

Agent-managed BIRD files live in `/var/lib/netagent/` on each router; the Nix-generated base
config is read-only. `lab-reset` on a router restores the baseline files.
