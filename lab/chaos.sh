#!/usr/bin/env bash
# Inject realistic failures into the lab.  Usage: lab/chaos.sh list | <scenario> | reset
set -euo pipefail

LAB="$(cd "$(dirname "$0")" && pwd)/lab.sh"
on() { "$LAB" ssh "$@"; }

declare -A DESC=(
  [bgp-peer-as]="r2: wrong remote AS for r1 (65099) -> BGP r1-r2 rejected with Bad peer AS"
  [prefix-filter]="r1: import filter toward r2 has a typo'd prefix list -> session up, 0 routes imported"
  [link-down]="r3: interface to-r4 administratively down -> BGP r3-r4 down, traffic reroutes"
  [dns-firewall]="r4: nftables rule drops DNS -> lab names stop resolving everywhere"
  [dns-service]="r4: unbound stopped -> lab names stop resolving everywhere"
  [meltdown]="bgp-peer-as + link-down + dns-service at once -> ring split in two islands, DNS dead"
)

case "${1:-list}" in
  list)
    for s in "${!DESC[@]}"; do printf '%-14s %s\n' "$s" "${DESC[$s]}"; done | sort ;;
  bgp-peer-as)
    on r2 "sed -i '/protocol bgp bgp_r1/,/^}/s/neighbor \(.*\) as 65001;/neighbor \1 as 65099;/' /var/lib/netagent/bgp.conf && birdc configure >/dev/null" ;;
  prefix-filter)
    on r1 "sed -i '/protocol bgp bgp_r2/,/^}/s/import filter import_peer;/import where net ~ [ 10.200.0.0\/16+ ];/' /var/lib/netagent/bgp.conf && birdc configure >/dev/null" ;;
  link-down)
    on r3 "ip link set to-r4 down" ;;
  dns-firewall)
    on r4 "nft -f - <<'EOF'
table inet hardening {
  chain input {
    type filter hook input priority -10; policy accept;
    udp dport 53 drop
    tcp dport 53 drop
  }
}
EOF" ;;
  dns-service)
    on r4 "systemctl stop unbound" ;;
  meltdown)
    for s in bgp-peer-as link-down dns-service; do "$0" "$s" >/dev/null; done ;;
  reset)
    for r in r1 r2 r3 r4; do on "$r" "lab-reset >/dev/null; systemctl start unbound 2>/dev/null || true" & done
    wait ;;
  *)
    echo "unknown scenario: $1 (try: $0 list)"; exit 1 ;;
esac
[[ ${1:-list} == list ]] || echo "chaos: ${1} ${DESC[$1]:+— ${DESC[$1]}}"
