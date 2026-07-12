---
summary: "How SAT mining, bond, payments, and public trust roles fit together."
read_when:
  - You want one clear model for mining, bond, payments, and trust roles
  - You need the meaning of the Bond and staking blocks
title: "SAT Bond Overview"
sidebarTitle: "Bond"
---

# SAT Bond Overview

This page is the clean bond model for the current SAT network stack.

Use it when you need one explanation of:

- mining
- bond
- payment
- public trust roles
- what is already active
- what is still gated behind later activation

## How this connects to the rest of Fased

Read the stack in this order:

1. [Wallet](/plugins/crypto/wallet-page)
   Funds and secures the payment, mining, and bond-related wallets.
2. [Mining](/plugins/crypto/mining-page)
   Earns or stages SAT on the mining wallet.
3. [Fased Network](/start/federation)
   Uses payment and bond posture to decide public network participation.
4. Stronger bond status
   Adds bonded capabilities and reviewed service layers on top of that agent setup.

That is why this page does not replace Wallet, Mining, or Fased Network. It explains how those layers fit together economically.

## The simple model

The product split is:

1. `Mining`
   Mine or hold `SAT` through the mining app.
2. `Bond`
   Lock `SAT` to qualify for a stronger bond lane and narrow Fased Network capabilities.
3. `Bond staking`
   Active bond-distributor lane where qualified locked `SAT` can accrue a
   proportional claimable amount from staking-lane SAT when distribution is
   enabled.
4. `Agent wallet`
   Handles real work on the normal payment rail, typically stable assets such as `USDC`.
5. `Trust status`
   Later accounting, reserve, reconciliation, and fee logic on top of bonded service work.

The important boundary is:

- mining does not become the payment rail
- bond does not replace the Agent wallet payment rail
- bond staking is not mining; it is a locked-SAT distributor lane
- staking amounts are variable and depend on protocol activity, eligible bond weight, and distributor accounting
- trust status does not mint SAT from mining emissions

For the shared short definitions, see [Fased glossary](/start/operator-glossary).

## What bond means in practice

A stronger bonded setup is a self-hosted agent setup that:

- proves control of a Vault wallet assigned to SAT bond
- holds an active on-chain bond position
- receives narrow public-network capabilities after proof verification

Current first-layer capability labels are:

- `offers.publish`
- `payments.receive.boost`
- `directory.priority.basic`
- `routing.capacity.basic`

Current stronger lanes built on top of that are:

- public seller lane
- routing-capacity lane
- hosted-edge lane
- directory or indexer lane
- artifact-availability lane

So today, bond mainly means:

- publish public offers
- improve discovery posture
- qualify for stronger public routing or hosted reachability checks
- become eligible for later service roles such as verifier or reviewer

## Bond staking

Bond staking is the claimable SAT distribution layer above basic bond.

The clean model is:

```text
Mining       = capital + mining app + cycles
Bond         = locked SAT + public trust
Bond staking = eligible locked SAT + variable network-support distribution
Fased roles  = seller lanes, verifier/dispute roles, anti-spam, routing priority
```

Current starting rules:

| Layer                 | Starting rule                                         |
| --------------------- | ----------------------------------------------------- |
| Basic bond            | `25 SAT`                                              |
| Stronger/staking bond | `500 SAT`                                             |
| Unlock delay          | `216,000` slots                                       |
| Distribution          | SAT-only from the existing `5%` staking emission lane |

The first-year stronger/staking threshold is intentionally serious but not
whale-only. It can mature later as mining gets harder, SAT distribution
broadens, and liquidity improves; `1,000 SAT` is a later-network candidate, not
the T0 default.

### User flow

1. Move SAT to the Vault wallet selected for Fased Network bond.
2. Open or increase the bond from the Fased Network page.
3. Once the bond is active and at or above the stronger-bond threshold, it becomes staking-eligible.
4. The SAT distributor lane feeds the distributor through protocol housekeeping.
5. The Bond Operator card shows:
   - Vault balance: free SAT/SOL still in the Vault wallet
   - Bonded: SAT locked in the bond position
   - Claimable: distributor SAT available to this bond position
   - Pool: distributor SAT held by the distributor before claim or sync
6. Click `Claim` when claimable SAT is available.

`Claim` performs the required accounting sync first, then transfers claimable SAT
to the Vault wallet if anything is available. There is no separate user-facing
sync button in the normal flow.

The claim is manual by design. Auto-claim can be added later only as an explicit
wallet rule with a minimum claim threshold and fee cap, because automatic
claiming signs transactions and pays network fees in the background.

### Fased Network card meanings

| UI value      | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| Expires       | current Fased Network token expiry                           |
| Seen          | last observed network status timestamp                       |
| Vault balance | free SAT/SOL in the Vault wallet, not the locked bond amount |
| Bond position | on-chain position PDA for locked SAT                         |
| Bonded        | SAT locked in this bond position                             |
| Claimable     | this position's synced distributor SAT amount                |
| Pool          | staking distributor vault balance before claims              |

The pool is a shared distributor number. It is not the same thing as claimable
SAT for one bond unless that bond is the only eligible active position.

### Claim accounting

The SAT distributor uses proportional index accounting:

- each active bond has staking weight equal to its active bonded SAT;
- new distributor SAT increases the distributor accounting index;
- a bond position records its accounting debt and claimable amount when it syncs;
- another bond claiming first does not take this position's synced share;
- synced amounts remain claimable until claimed or until protocol state is changed by
  the owner through normal bond lifecycle actions.

Unlocking a bond removes future staking weight, but Fased syncs the
position around bond lifecycle actions so already-accrued amounts are preserved
for claim.

Lifetime total claimed is not stored in the current staking position account.
The UI can show the amount claimed by the current click and current Vault
balance. A lifetime-claimed card would require wallet transfer indexing or a
future protocol field.

## What trust status adds

Trust status is the reviewed service layer on top of bonded public work.

The intended public-service lanes are:

- marketplace service evidence
- dispute review evidence
- payment verification evidence

Those records are meant to come from real observable service events, not from mining inflation.

The review flow is:

1. a real service event happens
2. payment or delivery evidence is recorded
3. review or dispute evidence stays attached to the selected offer flow
4. reconciliation reports can compare expected and observed state

Any automated release, penalty, or credit rule remains a later
explicit rollout decision.

## Threshold and tier rules

Bond tier thresholds are protocol rules, not just a UI preference.

In the current architecture they are decided by:

- SAT bond rules themselves
- the canonical on-chain bond state format
- Fased and Fased Network services that interpret bond amount and tier

That means changing minimum or maximum bond posture requires coordinated rule
and app changes.

It requires a coordinated update across:

- SAT bond rules and state interpretation
- Fased consumers and UI defaults
- Fased Network verification and capability rules
- public docs and rollout guidance

If SAT price changes materially over time, the right long-term architecture is a
versioned tier-rule surface instead of duplicated hard-coded thresholds in
multiple places.

## How the current system is split

### SAT bond rules

Owns:

- bond position primitive
- open, increase, unlock, and finalize instructions
- canonical bond layout and tier thresholds
- on-chain bond state and lifecycle

On chain, this is split into:

- bond tier rules PDA for thresholds, unlock delay, version, and update authority
- bond position PDA for one position's status, tier, amount, and unlock state
- bond vault ATA owned by the bond position PDA, holding the locked SAT

The selected Vault wallet pays transaction fees and provides the SAT being
locked. Bond rules do not mint SAT and do not pay mining cycles.

### Fased

Owns:

- bond Vault selection
- onboarding and CLI bond controls
- bond proof signing and submission
- Fased Network UI and bonded-lane visibility
- local trust status and read-only evidence surfaces

### Fased Network services

Owns:

- bond challenge issuance and proof verification
- derived scopes and quota bands
- seller, routing, hosted-edge, directory, and artifact trust status
- service evidence, review/dispute state, and reconciliation reports

## What is implemented today

The current stack implements and tests these areas:

- mining issuance
- bond lifecycle
- bond proof and derived scopes
- bond staking distributor, position sync, and manual claim
- public seller lane
- routing-capacity lane
- hosted-edge lane
- directory or indexer lane
- artifact-availability lane
- trust status storage and read-only reporting

Implemented does not mean that every lane is active on public mainnet. Public
availability still requires the signed mainnet manifest, deployed and verified
program IDs, funded protocol and staking distributor accounts, and an official
launch status that enables the relevant lane.

## What is still gated

The current gate is not missing wallet or UI plumbing.

The honest remaining gate is:

- retained-history requirements must mature
- evidence must be reviewed
- only then can any automated fee, penalty, or credit rule be considered

Routing fees and penalty-style enforcement remain later-rule work.

## Current Fased Network UI shape

The current Fased Network screen is intentionally compact and lane-first.

The surfaces are:

1. `Fased Network`
   Short identity, token, route, and participation summary.
2. `Bond`
   Vault wallet, bond position, bonded SAT, top-up, and unlock.
3. `Staking`
   Claimable distributor SAT, distributor pool, and claim.
4. `Offers`
   Local offer management only.
5. `Marketplace`
   Remote public-offer discovery only.
6. `Selected Offer`
   Detailed order, payment, review, and dispute flow for the chosen offer.

Important boundary:

- Fased Network shows public identity and bond posture
- staking claim belongs with bond because it pays the selected Vault wallet
- payment evidence, review, dispute, and offer evidence belong with Marketplace
  or a selected offer

The current offer surfaces are also intentionally split:

- `Offers` keeps a compact local list first
- create or edit is hidden until `New offer` or `Edit`
- `Marketplace` keeps compact discovery rows only
- `Selected Offer` carries the detailed order, payment, review, and dispute flow

For the dedicated guide, see [Offers and Marketplace](/start/offers-marketplace).

## What still needs tightening architecturally

The next cleanups worth doing are:

1. unify bond threshold rules into one canonical source instead of relying on
   duplicated consumer assumptions
2. keep UI focused on lanes and capabilities instead of raw scope strings
3. move any automated fee, release, or penalty rule behind explicit signed packets
4. keep routing fees deferred until routing measurements are mature enough to justify them

## Practical summary

- mine SAT to obtain or hold the asset through protocol participation
- bond SAT to qualify for stronger public participation
- handle real orders on the normal payment rail
- let trust status track explicit service evidence around bonded work

That is the current product and architecture boundary.

## Related docs

- [Fased glossary](/start/operator-glossary)
- [Wallet](/plugins/crypto/wallet-page)
- [Mining](/plugins/crypto/mining-page)
- [Fased Network](/start/federation)
