# Evaluation

Demos can be lucky; an eval is not. `netmedic eval` measures the whole system — detection,
investigation, remediation, verification — on every chaos scenario, repeatedly, with no human in
the loop.

## Method

For each run of each scenario (`src/netmedic/evaluate.py`):

1. reset the lab (`lab/chaos.sh reset`) and wait until every probe is healthy;
2. start a fresh watcher in **auto** mode and let it learn its baseline;
3. inject the scenario;
4. **success** = the network is back to its baseline (no symptom left, no incident running) within
   the budget (300 s); otherwise the run fails and its timeline is kept for the post-mortem.

Measured per run: time to detect, time to resolve, number of incidents, tool calls, tokens, cache
hit rate, cost, rollbacks. Physical scenarios (`cable-unplug`) need a human and are excluded.

## Results — Nov 2, 2026

Enterprise lab (8 routers), model `muse-spark-1.3-contributor`, 2 runs per scenario.
**15/16 runs resolved (94 %).**

| Scenario | What breaks | Success | Detect | Resolve | Tool calls | Cost/run |
|---|---|---|---|---|---|---|
| branch-limit | import limit on the branch session | 2/2 | 9.6 s | 45 s | 13 | $0.004 |
| dns-firewall | nftables drops DNS on dc1 | 2/2 | 11.6 s | 58 s | 11 | $0.002 |
| dns-service | unbound stopped on dc1 | 2/2 | 9.6 s | 53 s | 10 | $0.003 |
| failover-broken | ISP outage + latent typo in the backup filter | 2/2 | 11.6 s | 71 s | 16 | $0.004 |
| meltdown | 3 faults at once | 2/2 | 14.6 s | 109 s | 37 | $0.007 |
| nexthop-self | `next hop self` removed on edge1 | 1/2 | 10.1 s | 195 s | 47 | $0.011 |
| ospf-mtu | MTU mismatch, OSPF stuck in ExStart | 2/2 | 13.1 s | 83 s | 35 | $0.008 |
| rr-client | every `rr client` dropped on both reflectors | 2/2 | 14.6 s | 252 s | 94 | $0.014 |

Medians per run. *Resolve* is the time from injection until the network is back to its baseline,
including verification. Cache hit rates were 41–76 %.

Physical scenario, measured separately with the Rack Vision flow (4 runs): the agent asked for a
photo 8–18 s after detection every time, proposed no configuration change, and closed the
incident as escalated with the port to re-plug in 50–65 s, for $0.003–0.004.

## The failure

`nexthop-self` run 2: the first incident restored `next hop self ebgp` on edge1's session to core1 —
but the same plan also renamed the eBGP session `ebgp_isp1` to `ibgp_fix_marker`. Its checks
passed, so the change was kept; the renamed protocol no longer matched the baseline, two more
incidents followed, and the run ran out of budget. Lesson: a check proves a symptom is gone, not
that nothing else changed. The executor now refuses edits that rename a BIRD protocol.

## History

| Date | Runs | Resolved | Notes |
|---|---|---|---|
| Oct 28 | 16 | 12 (75 %) | failures traced to a wrong default file name, a too strict route check and a too strict eval criterion |
| Oct 28 | 8 (hard scenarios) | 6 (75 %) | one stalled API call, one second incident after the fix → tighter API timeouts, per-run timelines |
| Nov 2 | 16 | 15 (94 %) | after multi-step plans, photo requests and watcher fixes |

Reproduce: `lab/lab.sh use enterprise && lab/lab.sh up && uv run netmedic eval --runs 2`.
