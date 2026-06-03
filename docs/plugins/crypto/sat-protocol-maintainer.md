---
summary: "How the SAT protocol maintainer runs reserve refill, fixed-recipient treasury and staking claims, staking distributor feed, cleanup, standby, and alerts."
read_when:
  - You operate a Fased host that participates in SAT protocol maintenance
  - You need to verify reserve, treasury, staking, cleanup, standby, or alerts
  - You want to understand why maintainer calls are not treasury custody
title: "SAT Protocol Maintainer"
sidebarTitle: "SAT maintainer"
---

# SAT Protocol Maintainer

The SAT protocol maintainer is operator tooling for protocol upkeep. It is not
the normal Mining page, and it is not a treasury custody wallet.

The maintainer submits transactions that make already-defined protocol state
move forward:

- refill registry reserve up to the configured target;
- claim treasury SAT/SOL to fixed treasury recipients;
- claim staking SAT into the bond staking distributor;
- claim staking SOL to the configured ops/staking-SOL recipient;
- clean up resolved accounts so rent returns to the expected owner/PDA;
- record logs and monitor alert state.

The caller pays transaction fees. Program state fixes recipients and caps, so a
caller cannot redirect treasury/staking funds to themselves.

## What it is not

The maintainer is not:

- a normal user mining control;
- a wallet send surface;
- a bond top-up surface;
- a Marketplace fee release surface;
- a way to choose arbitrary treasury recipients;
- a replacement for signer, passkey, split-key, or wallet policy.

Mining users still use the Mining page for miner-owned work. Fased Network users
still use the Bond/Staking card for their own bond claim.

## Maintenance lanes

| Lane                 | Source                                | Destination                             | Caller can redirect? |
| -------------------- | ------------------------------------- | --------------------------------------- | -------------------- |
| Registry reserve     | protocol treasury SOL vault           | `sat_registry_reserve` up to target/cap | No                   |
| Treasury SAT/SOL     | protocol pending lanes                | configured treasury recipient           | No                   |
| Staking SAT feed     | protocol pending staking SAT          | bond distributor vault                  | No                   |
| Staking SOL claim    | protocol pending staking SOL          | configured ops/staking-SOL recipient    | No                   |
| Cleanup/reclaim rent | resolved cycle/page/progress accounts | expected PDA/owner or reserve path      | No                   |

This is why the maintainer can be run by a hot payer without giving that payer
treasury custody.

## Why Solana needs a caller

Solana programs do not run on their own timer. Someone must submit a transaction
that invokes the program.

The clean model is:

```text
permissionless bounded instruction
+ fixed recipients/caps
+ team or operator payer
+ monitor/standby
= protocol maintenance without treasury custody
```

Production deployments should run a monitored maintainer. The program should
still keep maintenance calls bounded when submitted by any eligible caller.

## Registry reserve

The registry reserve is a rent float for shared cycle/page/progress accounts.
It is mostly locked SOL, not daily spent SOL. Cleanup returns rent when resolved
accounts close.

Recommended policy:

| Environment   | Reserve target                                               |
| ------------- | ------------------------------------------------------------ |
| dev/test      | small buffer appropriate for local testing                   |
| public launch | target from launch configuration and observed account demand |

Before launch, the monitor should report no reserve shortfall.

## Running it

The exact unit names can differ by install channel, but the reference user-level
service shape is:

```bash
systemctl --user status fased-sat-maintainer.service
systemctl --user list-timers fased-sat-maintainer-standby.timer fased-sat-maintainer-monitor.timer --all
```

Useful logs:

```bash
tail -n 50 ~/.fased/sat-maintainer.jsonl
cat ~/.fased/sat-maintainer-monitor-state.json
```

The maintainer should run with:

- a dedicated payer wallet with enough SOL for transaction fees;
- the same trusted RPC profile used for operator maintenance;
- thresholds so it does not submit tiny claim/refill transactions every loop;
- jitter/backoff so multiple operators do not collide constantly;
- monitor state for freshness, failures, reserve, lanes, and cleanup backlog.

## Primary, standby, and monitor

Use three separate responsibilities:

| Component | Responsibility                                                          |
| --------- | ----------------------------------------------------------------------- |
| Primary   | regular maintenance loop                                                |
| Standby   | periodic takeover attempt when primary is stopped or unhealthy          |
| Monitor   | read-only alert state for freshness, payer SOL, reserve, lanes, cleanup |

Expected behavior:

- primary lock prevents double-running;
- standby skips when primary is healthy;
- standby can run a maintenance pass after primary stops;
- primary can resume after standby takeover;
- repeated calls do not double-claim, over-refill, or redirect funds.

## Alert state

Launch alerting should cover:

- no recent successful maintainer pass;
- maintainer failure streak;
- payer SOL below threshold;
- registry reserve below target;
- pending treasury/staking lanes growing;
- cleanup backlog growing;
- RPC failure or rate-limit streak.

Alert delivery is operator-specific. The monitor state is not enough by itself
unless someone actually receives and acts on the alert.

## Evidence checklist

For a real launch drill, record:

- primary maintainer pass log;
- standby skip while primary is healthy;
- standby pass after primary stop;
- primary resume after standby;
- reserve refill transaction or no-op proof when reserve is full;
- treasury claim transaction or no-op proof when pending lanes are empty;
- staking SAT feed transaction or no-op proof;
- staking SOL claim transaction or no-op proof;
- cleanup/reclaim transaction or no-op proof;
- monitor alert state before and after the drill.

## Read next

<Columns>
  <Card title="Mining" href="/plugins/crypto/mining-page" icon="pickaxe">
    Miner-owned mining controls stay on the Mining page.
  </Card>
  <Card title="Mining troubleshooting" href="/plugins/crypto/mining-troubleshooting" icon="circle-help">
    Diagnose skipped cycles, claim backlog, RPC errors, and low commit.
  </Card>
  <Card title="Bond + economy" href="/start/bond-operator-economy" icon="badge-check">
    Understand bond, staking claim, and operator lanes.
  </Card>
  <Card title="Security test report" href="/security/security-test-report" icon="shield-check">
    Review host, wallet, task, mining, and maintainer evidence status.
  </Card>
</Columns>
