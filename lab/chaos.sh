#!/usr/bin/env bash
# Inject realistic failures into the current lab topology (see lab/lab.sh use).
#   lab/chaos.sh list | <scenario> | reset
set -euo pipefail

LAB_DIR="$(cd "$(dirname "$0")" && pwd)"
LAB="$LAB_DIR/lab.sh"
TOPO="${LAB_TOPO:-$(cat "$LAB_DIR/state/topology" 2>/dev/null || echo ring)}"
export LAB_TOPO="$TOPO"
on() { "$LAB" ssh "$@"; }
NA=/var/lib/netagent

declare -A DESC
if [[ $TOPO == ring ]]; then
  DESC=(
    [bgp-peer-as]="r2: wrong remote AS for r1 (65099) -> BGP r1-r2 rejected with Bad peer AS"
    [prefix-filter]="r1: import filter toward r2 has a typo'd prefix list -> session up, 0 routes imported"
    [link-down]="r3: interface to-r4 administratively down -> BGP r3-r4 down, traffic reroutes"
    [dns-firewall]="r4: nftables rule drops DNS -> lab names stop resolving everywhere"
    [dns-service]="r4: unbound stopped -> lab names stop resolving everywhere"
    [meltdown]="bgp-peer-as + link-down + dns-service at once -> ring split in two islands, DNS dead"
  )
else
  DESC=(
    [ospf-mtu]="core2: MTU 1400 on to-dc1 -> OSPF adjacency stuck in ExStart (hidden by redundancy)"
    [nexthop-self]="edge1: 'next hop self' removed -> isp1 routes unresolvable, silent failover to the backup ISP"
    [rr-client]="core1+core2: a template push dropped every 'rr client' -> nothing is reflected, dc1 loses the internet"
    [branch-limit]="core1: import limit 2 on the branch session -> 'route limit exceeded', session disabled"
    [failover-broken]="isp1 outage (provider side) + latent typo in edge2's upstream filter -> internet down"
    [dns-service]="dc1: unbound stopped -> lab names stop resolving everywhere"
    [dns-firewall]="dc1: nftables rule drops DNS -> lab names stop resolving everywhere"
    [meltdown]="failover-broken + ospf-mtu + branch-limit at once"
  )
fi

dns_firewall() {
  on "$1" "nft -f - <<'EOF'
table inet hardening {
  chain input {
    type filter hook input priority -10; policy accept;
    udp dport 53 drop
    tcp dport 53 drop
  }
}
EOF"
}

run() {
  case "$TOPO:$1" in
    # ---------------- ring ----------------
    ring:bgp-peer-as)
      on r2 "sed -i '/protocol bgp bgp_r1/,/^}/s/neighbor \(.*\) as 65001;/neighbor \1 as 65099;/' $NA/bgp.conf && birdc configure >/dev/null" ;;
    ring:prefix-filter)
      on r1 "sed -i '/protocol bgp bgp_r2/,/^}/s/import filter import_peer;/import where net ~ [ 10.200.0.0\/16+ ];/' $NA/bgp.conf && birdc configure >/dev/null" ;;
    ring:link-down) on r3 "ip link set to-r4 down" ;;
    ring:dns-firewall) dns_firewall r4 ;;
    ring:dns-service) on r4 "systemctl stop unbound" ;;
    ring:meltdown) for s in bgp-peer-as link-down dns-service; do run "$s"; done ;;

    # ---------------- enterprise ----------------
    enterprise:ospf-mtu) on core2 "ip link set to-dc1 mtu 1400 && birdc restart ospf1 >/dev/null" ;;
    enterprise:nexthop-self)
      on edge1 "sed -i '/next hop self ebgp;/d' $NA/30-bgp.conf && birdc configure >/dev/null" ;;
    enterprise:rr-client)
      for c in core1 core2; do
        on "$c" "sed -i '/rr client;/d' $NA/30-bgp.conf && birdc configure >/dev/null"
      done ;;
    enterprise:branch-limit)
      on core1 "sed -i '/protocol bgp ebgp_branch1/,/^}/s/import limit 10 action disable;/import limit 2 action disable;/' $NA/30-bgp.conf && birdc configure >/dev/null && birdc restart ebgp_branch1 >/dev/null" ;;
    enterprise:failover-broken)
      # Latent misconfiguration first (invisible while isp1 is up), then the provider outage.
      on edge2 "sed -i 's|if net ~ \[ 10.100.0.0/16, 10.110.0.0/16 \] then accept;|if net ~ [ 10.10.0.0/16, 10.110.0.0/16 ] then accept;|' $NA/10-policy.conf && birdc configure >/dev/null"
      on isp1 "ip link set to-edge1 down" ;;
    enterprise:dns-service) on dc1 "systemctl stop unbound" ;;
    enterprise:dns-firewall) dns_firewall dc1 ;;
    enterprise:meltdown) for s in failover-broken ospf-mtu branch-limit; do run "$s"; done ;;

    *:reset)
      # Every router in parallel, generous timeout, and report failures instead of ignoring them.
      local pids=() names=() failed=0 i
      for r in $(LAB_TOPO=$TOPO "$LAB" routers); do
        LAB_SSH_TIMEOUT=45 on "$r" "lab-reset >/dev/null && { systemctl start unbound nginx 2>/dev/null || true; }" &
        pids+=($!); names+=("$r")
      done
      for i in "${!pids[@]}"; do
        wait "${pids[$i]}" || { echo "reset FAILED on ${names[$i]}" >&2; failed=1; }
      done
      return $failed ;;
    *) echo "unknown scenario for topology '$TOPO': $1 (try: $0 list)"; exit 1 ;;
  esac
}

case "${1:-list}" in
  list) echo "topology: $TOPO"; for s in "${!DESC[@]}"; do printf '  %-16s %s\n' "$s" "${DESC[$s]}"; done | sort ;;
  *) run "$1"; [[ $1 == reset ]] && echo "chaos: reset ($TOPO)" || echo "chaos: $1 — ${DESC[$1]:-}" ;;
esac
