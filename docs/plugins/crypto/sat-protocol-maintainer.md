---
summary: "How SAT protocol maintenance runs reserve refill, fixed-recipient claims, cleanup, standby, and alerts."
read_when:
  - You operate a Fased host that participates in SAT protocol maintenance
  - You need to verify reserve, treasury, distributor, cleanup, standby, or alerts
  - You want to understand why maintainer calls are not treasury custody
title: "SAT Protocol Maintainer"
sidebarTitle: "SAT maintainer"
---

# SAT Protocol Maintainer

The SAT protocol maintainer is operator tooling for protocol upkeep. Mining
users still use the Mining page. Treasury custody stays separate from the hot
maintainer payer.

The maintainer submits transactions that make already-defined protocol state
move forward:

- refill registry reserve up to the configured target;
- claim treasury SAT/SOL to fixed treasury recipients;
- claim distributor SAT into the bond distributor;
- clean up resolved accounts so rent returns to the expected owner/PDA;
- record logs and monitor alert state.

The caller pays transaction fees. Program state fixes recipients and caps, so a
caller cannot redirect treasury or distributor funds to themselves.

## Scope

The maintainer is limited to bounded protocol maintenance:

- reserve refill to configured caps;
- fixed-recipient treasury and SAT distributor claims;
- bond distributor feed;
- cleanup/reclaim for resolved accounts;
- monitor and standby records.

Mining users still use the Mining page for miner-owned work. Fased Network users
still use the Bond card for their own bond claim.

## Maintenance lanes

**Registry reserve**

Source: protocol treasury SOL vault. Destination: `sat_registry_reserve` up to
the configured target/cap.

**Treasury SAT/SOL**

Source: protocol pending lanes. Destination: configured treasury recipient.

**SAT distributor feed**

Source: protocol pending distributor SAT. Destination: bond distributor vault.

**Cleanup/reclaim rent**

Source: resolved cycle/page/progress accounts. Destination: expected PDA/owner
or reserve path.

Cleanup is intentionally incremental. A maintainer pass can submit a small
number of cleanup transactions, return `deferred`, and let the next pass continue
from the same resolved backlog. This keeps one-shot maintenance calls inside the
gateway timeout while still reclaiming old accounts over time.

Maintainer responses are compact by default. The normal response reports the
maintenance lanes, pending treasury/distributor amounts, registry reserve state,
and cleanup backlog/defer reason. Full dashboard/debug status is available on
request, but the loop should not pull it every pass.

Program state fixes recipients and caps for all lanes.

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
- monitor state for freshness, failures, reserve, lanes, and cleanup backlog;
- compact status mode for the regular loop and debug status mode only during
  investigations.

Runner batch knobs:

```bash
FASED_SAT_MAINTAIN_CLEANUP_BATCH_MODE=auto
FASED_SAT_MAINTAIN_CLEANUP_MAX_BATCH_INSTRUCTIONS=4
```

Cleanup discovery has two modes:

- `recent`: default. Use local backlog, recent actions, and observed cycle state
  first. This avoids asking RPC for every historical cycle account.
- `scan`: explicit backfill/debug. This uses broad program-account scans and can
  get slower as devnet/mainnet history grows.

Cleanup batching is available as an opt-in soak path. Use
`--cleanup-batch-mode auto` to let the maintainer combine multiple resolved
miner-cycle or registry-page close instructions into one signed transaction,
capped by `--cleanup-max-batch-instructions`.

The local signer still validates the batch as a SAT cleanup operation. It
rejects non-cleanup instructions, mixed wallet IDs, and batches above the signer
cap. If the installed signer is older and does not support the batch operation,
Fased falls back to single cleanup transactions.

## Primary, standby, and monitor

Use three separate responsibilities:

**Primary**

Regular maintenance loop.

**Standby**

Periodic takeover attempt when primary is stopped or unhealthy.

**Monitor**

Read-only alert state for freshness, payer SOL, reserve, lanes, and cleanup.

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
- pending treasury or distributor lanes growing;
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
- SAT distributor feed transaction or no-op proof;
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
    Understand bond, distributor claims, and operator lanes.
  </Card>
  <Card title="Security test report" href="/security/security-test-report" icon="shield-check">
    Review host, wallet, task, mining, and maintainer evidence status.
  </Card>
</Columns>
