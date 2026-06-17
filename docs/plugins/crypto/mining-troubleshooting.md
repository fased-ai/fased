---
summary: "Troubleshoot Satcoin mining commit sizing, skipped cycles, clearing state, RPC errors, claim backlog, and recovery."
read_when:
  - Your mining commit is lower than the saved target
  - Mining skipped cycles or stopped submitting
  - RPC, claim, clearing, or recovery state looks confusing
title: "Mining Troubleshooting"
sidebarTitle: "Mining troubleshooting"
---

# Mining Troubleshooting

Use this page when the Mining page is running but the current cycle, commit,
claim, or recovery state does not match what you expected.

Mining is an operating loop:

```text
wallet SOL -> miner capital -> safe commit -> cycle submit -> settlement -> claim -> free capital
```

Each step has a separate blocker. A healthy Fased Agent can still submit a smaller
cycle than the saved target when capital is locked, wallet SOL is low, or
recovery is clearing older cycles.

## Target max is high, but submitted commit is low

This is usually normal.

`Target max` is the saved upper limit for later. It is not a promise that every
cycle can use that amount. The actual submitted commit is capped by:

- free miner capital;
- locked capital from pending cycles;
- wallet SOL fee reserve;
- signer fee/rent buffer;
- minimum-entry and erosion coverage;
- recovery and claim state.

Common messages:

| Message                                   | Meaning                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `Commit reduced: locked capital clearing` | earlier cycles still hold capital until settlement/claim frees it       |
| `Commit reduced: fee reserve`             | the mining wallet needs more SOL outside miner capital for fees/rent    |
| `Commit reduced: free capital`            | the miner capital PDA has less free SOL than the saved target right now |
| `Commit restored: capital unlocked`       | older capital cleared and Fased Agent could raise commit again          |

If commit drops for one cycle and returns on the next cycle, Fased Agent is
usually doing the right thing: it kept participating instead of idling.

## Locked capital clearing

Submitted cycle capital is not immediately free. It clears after the cycle is
settled, distributed, claimed, and closed where applicable.

Expected signs:

- `Locked` is non-zero;
- `Withdraw` is lower than total capital;
- Fased Agent may submit a smaller cycle;
- the claim/recovery worker keeps running;
- later cycles can restore toward the saved target once capital unlocks.

Do not repeatedly press `Stop` to accelerate clearing. `Stop` blocks new submits.
It does not make Solana settlement or claim state finish instantly.

## Wallet SOL reserve reduced commit

Miner capital is not the same as wallet SOL.

The mining wallet still needs SOL outside miner capital for:

- transaction fees;
- priority fees when configured;
- miner-cycle account rent;
- associated token account rent when needed;
- retries after blockhash expiry, RPC timeout, or account lock conflict.

If the Mining page reports fee reserve pressure, top up the mining wallet SOL.
Do not solve fee reserve problems by depositing all wallet SOL into miner
capital.

## Missed or skipped cycles

A skipped cycle means Fased Agent did not submit into that cycle from this
wallet. Causes include:

- free capital below minimum entry;
- locked capital not yet clear;
- wallet SOL below fee reserve;
- RPC rate limit or stale state;
- signer unavailable;
- gateway restart during a submit window;
- previous cycle still in a claim/recovery path.

What to check:

```bash
fased mining status --json
fased mining history --window 24h
fased mining readiness --wallet mining
fased wallet signer doctor --json
```

If mining is running and later submits resume, a short skipped range is not
automatically a protocol failure. A long skipped range with enough free capital
and wallet SOL usually points to RPC, signer, or recovery state.

## Stop, clearing, and resume

`Stop` means no new cycle submits.

If capital is locked, mining enters clearing:

- no new submits;
- claim and recovery can keep running;
- capital returns as cycles settle and claim;
- use `Resume` or `Start` after clearing when you want new submits again.

If you want to pause new risk but recover funds, use Stop and wait for clearing.
If you want mining to continue, do not stop while old cycles are pending.

## Claimable SAT is zero

Claim depends on settlement and distribution, not only on submit.

Possible reasons:

- current cycle has not settled yet;
- distribution pages are still pending;
- claim already ran;
- claim backlog is waiting on an older ready cycle;
- RPC returned stale account state;
- the wallet is out of fee SOL for claim.

Use Mining history to compare the submitted cycle, settled cycle, claim record,
and latest wallet SAT balance.

## RPC stale, rate limited, or slow

Mining reads account state frequently. Public RPC can work for light tests, but
long-running mining should use a reliable private or commercial RPC.

Symptoms:

- rate limited errors;
- stale current cycle;
- failed simulation after a transaction already landed;
- delayed claim status;
- missed submit window;
- endpoint failover messages.

Use [Solana RPC setup](/plugins/crypto/wallet-rpc-setup) before serious mining.
If the UI looks stale after a claim, refresh once and check history before
retrying the same action.

## Strategy outcome was not better

Strategy modes control mining decisions. Outcomes vary by cycle, crowding,
fees, missed windows, and other miners.

A single miner can prove that strategy selection submits valid cycles, but it
does not prove one strategy outperforms another. Strategy performance needs
multi-miner evidence with equal commits, rotated wallets, and recorded
deterministic rebate, performance rebate, score versus benchmark, SAT earned,
and net SOL cost.

## Quick recovery checklist

1. Confirm signer health.
2. Confirm mining wallet SOL is above reserve.
3. Confirm free miner capital is above minimum entry.
4. Check pending and locked cycles.
5. Check claim backlog.
6. Check RPC rate limit/failover messages.
7. Restart the gateway only after reading current status.
8. Let recovery/claim finish before changing wallets or deleting local state.

## Read next

<Columns>
  <Card title="Mining" href="/plugins/crypto/mining-page" icon="pickaxe">
    Return to the main Mining page guide.
  </Card>
  <Card title="Advanced mining" href="/plugins/crypto/mining-advanced" icon="sliders-horizontal">
    Understand capital safety, strategy, claim, sweep, and recovery.
  </Card>
  <Card title="Mining automation" href="/plugins/crypto/mining-chat-and-automation" icon="bot">
    Review chat, task, and strategy automation boundaries.
  </Card>
  <Card title="RPC setup" href="/plugins/crypto/wallet-rpc-setup" icon="radio-tower">
    Configure reliable Solana RPC for long-running mining.
  </Card>
</Columns>
