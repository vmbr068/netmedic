# "enterprise" lab: a dual-homed enterprise network, built to be hard to troubleshoot.
#
#        isp1 (AS64501) ════════ isp2 (AS64502)      transit providers (NOT managed by netmedic)
#            │ eBGP primary          │ eBGP backup
#          edge1 ─────────┐   ┌───── edge2           border routers, AS65000
#            │  ╲          ╳          ╱ │
#          core1 ═════════════════ core2             OSPF area 0 + iBGP route reflectors
#            │   ╲                 ╱    │
#           dc1 (DNS + web app)  branch1 (AS65010)   datacenter (RR client) / branch office (eBGP)
#
# Design (the agent gets it as "network design notes"):
# - OSPF carries infrastructure loopbacks only; customer prefixes are carried by BGP.
# - iBGP over loopbacks, core1/core2 are route reflectors, edges set next-hop-self.
# - isp1 is the primary upstream (local-pref 200), isp2 the backup (local-pref 100).
# - AS65000 announces the aggregates 10.100.0.0/16 (own) and 10.110.0.0/16 (branch) upstream.
#
# SSH: 127.0.0.1:<2220 + id> (ids 11-18, so the ring lab can run alongside).
# Addressing: link i -> 172.16.<i>.0/30 (.1 = first router listed), loopback 10.0.255.<id>/32,
# customer LAN 10.100.<id>.0/24 (AS65000) / 10.110.<id>.0/24 (branch), app VIP 10.100.<dc>.10.
{
  notes = ''
    Dual-homed enterprise network, AS65000.
    - OSPF area 0 (BIRD protocol ospf1) carries infrastructure loopbacks only; customer prefixes
      (10.100.<id>.0/24, branch 10.110.0.0/16) are carried by BGP.
    - iBGP over loopbacks: core1 and core2 are route reflectors (rr client towards edge1, edge2,
      dc1). Edges and cores set "next hop self ebgp" on iBGP (eBGP-learned routes get the
      router's loopback as next hop, since eBGP link subnets are not in OSPF).
    - edge1 <-> isp1 (AS64501) is the primary upstream (local-pref 200), edge2 <-> isp2 (AS64502)
      the backup (local-pref 100). Edges announce only 10.100.0.0/16 and 10.110.0.0/16 upstream.
    - branch1 (AS65010) is dual-homed to core1 and core2 over eBGP.
    - dc1 hosts DNS (unbound, 10.0.255.17) and the web app app.lab (10.100.17.10, nginx).
    - isp1 and isp2 belong to the providers: they are NOT managed, you cannot change them. If a
      fault is on their side, route around it and say it must be escalated to the provider.
    - Agent-managed BIRD files: /var/lib/netagent/10-policy.conf (filters, aggregates),
      20-ospf.conf (OSPF), 30-bgp.conf (BGP sessions).
    - "internet" test prefixes: 198.51.100.1 (behind isp1), 203.0.113.1 (behind isp2).
  '';

  # Reachability targets every managed router must be able to ping ("the internet").
  targets = [ "198.51.100.1" "203.0.113.1" ];

  routers = {
    isp1 = { id = 11; asn = 64501; role = "isp"; layer = 0; managed = false; internet = "198.51.100.1/24"; };
    isp2 = { id = 12; asn = 64502; role = "isp"; layer = 0; managed = false; internet = "203.0.113.1/24"; };
    edge1 = { id = 13; asn = 65000; role = "edge"; layer = 1; upstreamPref = 200; };
    edge2 = { id = 14; asn = 65000; role = "edge"; layer = 1; upstreamPref = 100; };
    core1 = { id = 15; asn = 65000; role = "core"; layer = 2; rr = true; };
    core2 = { id = 16; asn = 65000; role = "core"; layer = 2; rr = true; };
    dc1 = { id = 17; asn = 65000; role = "dc"; layer = 3; services = [ "dns" "web" ]; };
    branch1 = { id = 18; asn = 65010; role = "branch"; layer = 3; lan = "10.110.18.1/24"; };
  };

  # Link index = position in this list (subnet 172.16.<index>.0/30).
  # Same AS on both ends -> internal link (OSPF); different AS -> eBGP session.
  links = [
    [ "isp1" "isp2" ]     # 0  the "internet"
    [ "isp1" "edge1" ]    # 1  primary upstream
    [ "isp2" "edge2" ]    # 2  backup upstream
    [ "edge1" "core1" ]   # 3
    [ "edge1" "core2" ]   # 4
    [ "edge2" "core1" ]   # 5
    [ "edge2" "core2" ]   # 6
    [ "core1" "core2" ]   # 7
    [ "core1" "dc1" ]     # 8
    [ "core2" "dc1" ]     # 9
    [ "core1" "branch1" ] # 10
    [ "core2" "branch1" ] # 11
  ];
}
