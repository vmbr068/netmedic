> Written by netmedic, unedited: the `failover-broken` incident from the demo video
> (`lab/chaos.sh failover-broken`: isp1 outage + a latent typo in edge2's backup filter).

# Incident report — 2026-11-02 17:22:47

**Status:** RESOLVED + ESCALATED  
**Duration:** 48.1s  
**Mode:** auto  

## Alert
Automated detection at 17:22:47.
Symptoms currently observed by the monitoring probes:
- edge1: cannot reach external target 198.51.100.1
- edge1: cannot reach external target 203.0.113.1
- edge2: cannot reach external target 198.51.100.1
- edge2: cannot reach external target 203.0.113.1
- core1: cannot reach external target 198.51.100.1
- core1: cannot reach external target 203.0.113.1
- core2: cannot reach external target 198.51.100.1
- core2: cannot reach external target 203.0.113.1
- dc1: cannot reach external target 198.51.100.1
- dc1: cannot reach external target 203.0.113.1
- branch1: cannot reach external target 198.51.100.1
- branch1: cannot reach external target 203.0.113.1

## Summary
Total internet loss: primary upstream down (edge1/isp1 unreachable, provider-side) + backup edge2 not announcing 10.100.0.0/16 due to export-filter typo. Fix edge2 announcement; escalate isp1 to provider.

## Root cause
Primary ebgp_isp1 down (provider-side, edge1 cannot reach 172.16.1.1) forced failover to edge2/isp2, but edge2 to_upstream filter typo (10.10.0.0/16 instead of 10.100.0.0/16) withholds 10.100.0.0/16 announcement so internet return traffic fails; all routers lose both internet targets.

**Affected:** edge1, edge2, core1, core2, dc1, branch1

## Evidence
- **95% — Backup edge2 does not announce 10.100.0.0/16 upstream (typo 10.10.0.0/16 in to_upstream filter), so return traffic for datacenter/edge sources via isp2 is dropped; failover half-works**
  - `edge2 bird_exported ebgp_isp2 shows only '10.110.0.0/16 blackhole [aggregates]' — 10.100.0.0/16 missing`
  - `edge2 aggregates has both '10.100.0.0/16 blackhole' and '10.110.0.0/16 blackhole'`
  - `edge2 10-policy.conf: 'filter to_upstream { if net ~ [ 10.10.0.0/16, 10.110.0.0/16 ] then accept; reject; }' vs edge1 correct '[ 10.100.0.0/16, 10.110.0.0/16 ]'`
  - `edge2 ping 172.16.2.1 OK but ping 203.0.113.1 '0 received, 100% packet loss' despite Established ebgp_isp2 and default route via isp2`
- **90% — Primary upstream ebgp_isp1 down due to fault beyond our side (provider/link): L1/L2 up but L3/TCP fails**
  - `edge1 ebgp_isp1 'start ... Connect BGP Error: Hold timer expired'`
  - `edge1 to-isp1 'UP ... mtu 1500' addr '172.16.1.2/30'`
  - `edge1 ping 172.16.1.1 '0 received, 100% packet loss'`
  - `edge1 TCP 172.16.1.1:179 CLOSED while firewall allows 'tcp dport { 22, 53, 80, 179 } accept'`
  - `edge1 ebgp_isp1 config correct: 'neighbor 172.16.1.1 as 64501'`

## Escalation
Provider AS64501 / isp1 side fault: edge1 to-isp1 interface is UP (to-isp1 UP mtu 1500, 172.16.1.2/30) with correct config (neighbor 172.16.1.1 as 64501) and firewall allows TCP 179/ping, but 172.16.1.1 is unreachable: 'PING 172.16.1.1 ... 3 packets transmitted, 0 received, 100% packet loss' and TCP 179 CLOSED, BIRD 'ebgp_isp1 ... Connect BGP Error: Hold timer expired'. Ask provider to check isp1 172.16.1.1 / link to edge1. Until restored, all internet traffic must use edge2/isp2 backup.

## Remediation plan

### Step 1: Correct edge2 to_upstream aggregate — kept
*Root cause addressed:* Backup edge2 does not announce 10.100.0.0/16 upstream (typo 10.10.0.0/16 in to_upstream filter), so return traffic for datacenter/edge sources via isp2 is dropped; failover half-works  
*Risk:* low

Fix typo in edge2 upstream export filter so both aggregates are announced to isp2

Actions:
- `{"type":"edit_bird_config","router":"edge2","file":"10-policy.conf","find":"if net ~ [ 10.10.0.0/16, 10.110.0.0/16 ] then accept;","replace":"if net ~ [ 10.100.0.0/16, 10.110.0.0/16 ] then accept;"}`

Execution log (0.1s):
- edge2: birdc configure check -> OK
- edge2: applied with `configure timeout 120` (BIRD auto-reverts unless confirmed): Reconfigured
- PASS route_exported {'router': 'edge2', 'protocol': 'ebgp_isp2', 'prefix': '10.100.0.0/16'}: 10.100.0.0/16 announced to ebgp_isp2
- edge2: birdc configure confirm
- all checks passed, change kept

## Alternatives considered
- none
