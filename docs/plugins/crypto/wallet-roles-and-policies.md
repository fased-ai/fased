---
summary: "Permanent Agent, Mining, and Vault roles plus fail-closed signer and skill policies."
read_when:
  - Choosing a wallet role
  - Configuring operations, programs, assets, destinations, caps, or skill grants
title: "Wallet roles and policies"
sidebarTitle: "Roles and policies"
---

# Wallet roles and policies

Fased wallet roles are security boundaries. Pick the role before creating or
importing a wallet and use a different account when the purpose changes.

## Role matrix

| Role   | Intended use                                                                                | Autonomous authority                                         | Manual authority                                                                                          |
| ------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Agent  | Everyday Agent work, receipts, skills, tasks, typed sends, reviewed Jupiter/Trigger actions | Optional, only under explicit typed policy and positive caps | Exact review plus signer WebAuthn for every manual native action                                          |
| Mining | SAT capital, commits, claims, cleanup, fees, and SAT sweep                                  | Generated SAT actions only                                   | Exact review plus signer WebAuthn for manual native SOL/SAT movement and maintenance                      |
| Vault  | Reserve and reviewed bond/federation authority                                              | None                                                         | Exact reviewed operation with native signer WebAuthn, Wallet Standard hardware signing, or Turnkey policy |

Agent and Vault may have multiple wallets. There is one active configured
Mining wallet, normally `@wallet:mining`.

Display names are labels. Risky requests use exact wallet ids or
`@wallet:<walletId>` handles.

## Fresh wallets are locked by policy

The native signer creates a wallet with its permanent role and an explicit
deny-all policy. A public address, healthy process, or configured RPC does not
grant signing.

An executable signer policy must name:

- wallet id and role;
- typed operations;
- exact programs;
- assets/mints;
- destinations;
- positive per-transaction and daily caps.

Missing policy and empty operations, programs, assets, mints, or destinations
mean no signing. There is no "empty means allow all" behavior.

## Version and hash acknowledgement

Signer policy is versioned, normalized, and hashed. Health exposes the exact
version/hash. The Gateway must not report a requested policy as active until
the signer acknowledges that exact hash.

The Gateway can request a tighter policy. Initial authority or a later
loosening uses the native owner/admin workflow and optimistic concurrency
against the current version.

If policy state is corrupt or unsupported, Fased preserves it and fails closed.
Do not delete it to obtain defaults.

## Agent policy

Start with manual reviewed sends. Add autonomous authority only for a concrete
workflow and limit all of these dimensions:

- `solana.nativeTransfer` or checked SPL transfer;
- exact program ids;
- exact SPL mint;
- exact destination addresses;
- maximum amount per transaction;
- maximum total per day.

Jupiter and Trigger actions require their own typed operation and semantic
validation. An allowlisted Jupiter program is not permission for an arbitrary
serialized transaction.

Keep the funded balance near the maximum working loss you intentionally accept.

## Mining policy

Mining policy permits generated SAT actions bound to the configured SAT main,
mint, and bond programs. The signer validates exact payloads, account flags,
PDAs, programs, mints, authorities, and destinations.

Mining needs SOL for fees/capital and receives SAT. It does not gain permission
for unrelated SPL tokens, general swaps, generic serialized signing, or use as
an Agent wallet.

## Vault policy

Vault is manual-only. Native Vault execution uses `review.prepare` and
`review.execute` with signer-owned WebAuthn bound to the exact transaction and
policy hash. Agent and Mining use the same signer WebAuthn gate whenever their
operation is manual/reviewed; their narrowly autonomous typed paths are the
policy-controlled exceptions.

Do not make Vault work by enabling generic direct signing. For stronger reserve
custody, attach a hardware-backed Solana Wallet Standard account and verify the
transaction on-device, or use a dedicated Turnkey API user under an independent
organization policy.

The old split-key/passphrase unlock model is not production Vault custody.

## Skill wallet grants

Skills can use Agent wallets only. Install/enable and wallet authority are
separate approvals.

A mutating skill request fails unless the grant explicitly includes every
relevant dimension:

- action;
- `agent` role;
- exact wallet ids;
- `solana` chain;
- trusted registry, or explicit `local` source;
- input and output mints used by the request;
- maximum amount and slippage;
- autonomous permission when applicable;
- scheduled/cron permission when applicable.

Example for an installed ClawHub skill:

```bash
fased skills wallet grant reviewed-wallet-skill \
  --wallet-id agent \
  --actions quote,swap \
  --chain solana \
  --registry https://clawhub.com \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint YOUR_ALLOWED_MINT \
  --max-amount 100000000 \
  --max-slippage-bps 50
```

For a reviewed local skill, use `--registry local`. Missing origin metadata does
not silently downgrade a marketplace skill to trusted local code.

The signer policy remains final and may reject an action even when the skill
grant allows it.

## Caps and accounting

Native caps are stored and reserved atomically by the signer. Restart does not
reset daily totals. Concurrent requests cannot both consume one remaining
allowance.

An unknown or already broadcast request counts against the cap until exact
reconciliation. Never change parameters and retry an uncertain transaction.

Gateway-side policy previews and ledgers improve UI/audit visibility but do not
replace signer enforcement.

## Policy changes

Before expanding authority:

1. verify wallet id, permanent role, and public address;
2. read current signer policy version/hash;
3. review the normalized diff;
4. confirm exact operations/programs/assets/destinations/caps;
5. apply through the native owner/admin helper;
6. verify signer health acknowledges the new version/hash;
7. test with a deliberately small amount;
8. review signer and Gateway audit logs.

After compromise or unexpected behavior, stop the Agent/miner, tighten policy,
reconcile pending/unknown requests, and sweep excess working value through a
reviewed operation. `Stop` alone is not a custody lock.

## Related docs

- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Autonomous wallet security](/plugins/crypto/wallet-autonomous-security)
- [Wallet passkeys](/plugins/crypto/wallet-control-passkey)
- [Skills](/tools/skills)
