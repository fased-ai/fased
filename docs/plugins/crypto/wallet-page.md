---
summary: "User guide to the Wallets page: inventory, funding, approvals, passkey control, security, and role assignments."
read_when:
  - You are using Wallets for the first time
  - You want to understand Agent wallet, mining, bond, send approval, or wallet security
title: "Wallets"
sidebarTitle: "Wallets"
---

# Wallets

The Wallets page is the day-to-day control surface for runtime wallets in Fased.

Use it to:

- see which wallets exist
- copy addresses and fund the right wallet
- confirm which wallets are Agent, mining, vault, or bond-adjacent
- create and approve sends
- turn on Wallet Control Passkey
- review split-key and lock state
- inspect wallet policy and recent activity

Use other pages for the economic workflows themselves:

- [Operator glossary](/start/operator-glossary) for shared wallet, mining, Fased Network, bond, and order terms
- [Mining](/plugins/crypto/mining-page) for Satcoin capital, commit, start, stop, claim, and sweep
- [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels) for `@wallet` balances, sends, advanced wallet actions, skills, and channel control
- [Mining Chat and Automation](/plugins/crypto/mining-chat-and-automation) for `@mining` start/stop/fund/withdraw/commit/strategy commands
- [Fased Network guide](/start/federation) for network participation and public route health
- [Bond operator](/start/bond-operator-economy) for bond posture and operator lanes

## How wallets fit into the stack

```mermaid
flowchart LR
    Onboard[Onboarding or CLI setup] --> Wallets[Wallets]
    Wallets --> Mining[Mining]
    Wallets --> Network[Fased Network]
    Network --> Bond[Bond operator lane]
    Network --> Offers[Offers and Marketplace]
```

Read it like this:

- onboarding creates or imports the wallet and registers it
- The Wallets page is where you inspect, fund, secure, and approve wallet actions
- Mining uses a dedicated mining wallet
- Fased Network uses the wallet map to show Agent wallet and bond posture
- bond lifecycle stays on the Fased Network surface even though the wallet is visible in Wallets

## Beginner path

For a first public setup, use this order:

1. Open **Wallets**.
2. Create or import one **Agent** wallet for normal sends, Marketplace order actions,
   reviewed wallet actions, scheduled wallet work, and skill wallet actions.
3. Create or import one **Mining** wallet only if you plan to run Satcoin mining.
4. Create or import one **Vault** wallet if you need protected storage or Fased
   Network bond authority.
5. Copy the address from the wallet card and fund the wallet from an external
   wallet or exchange.
6. Refresh balances and confirm the SOL arrived before sending, mining, or
   scheduling wallet work.
7. Open **Access** and enable Wallet Control Passkey before relying on approvals
   or split-key security.

Keep the roles separate. Agent wallets do normal agent work. The Mining wallet
does Satcoin mining only. Vault wallets are manual-first reserve/bond wallets.

## What you see on this page

The Wallets page is intentionally compact. The main sections are:

### 1. Access

The **Access** tab contains Wallet Control Passkey, the approval and ceremony
shortcut for wallet-sensitive actions.

Use it for:

- send approvals
- policy changes
- wallet security setup
- lock and unlock
- recovery
- device-share and second-device changes

### 2. Wallet inventory cards

This is the live wallet list.

Use it to answer:

- which wallets exist
- which address belongs to each wallet
- what balances are visible now
- which wallets are Agent wallets
- which wallet is configured as `@wallet:mining`
- which Vault wallet is currently assigned to Fased Network bond

### 3. Send and approval flow

The Wallets page is manual-first.

The real flow is:

1. choose the source wallet by exact `@wallet:<id>` handle
2. fill out the destination as another local wallet handle or an external address
3. click `Create Approval Request`
4. review the pending request, policy simulation, and approval diff
5. click `Approve`
6. complete passkey approval if enabled
7. let the runtime execute and log the send

That is why the Wallets page is an approval surface, not just a raw signer surface.

### 4. Selected wallet policy

This section changes by role.

- Agent wallets show `Caps`, `Send`, and `Auto`
- Vault wallets show `Caps` and `Security`
- Mining wallets show `Sweep`

### 5. Policy and safety

This is where you review or save wallet policy:

- Preset: one-click starting point for the selected wallet role
- Caps: optional per-wallet spend limits, Off by default on fresh wallets
- Send: one Agent-wallet recurring send policy shared by chat and the Wallets UI
- Auto: Agent background execution, On by default for Agent wallets
- Security: Vault split-key/passkey custody
- Sweep: Mining-only SAT movement after successful claims

Automated execution means the Agent wallet may execute approved background
actions when role policy, enabled caps, allowlists, and custody state allow it. It does
not control Wallets UI manual Send. Manual Send always creates a reviewed request,
then approval executes the request.

For Mining, automated signing is reserved for Satcoin mining operations and Satcoin
sweep. It does not allow generic chat, skill, wallet-action, or bond actions from the
mining wallet. For Agent, automation is the working-wallet path for approved
agent tasks. Vault stays manual-only and uses reviewed Wallets page approval.

Caps Off skips only cap comparisons. It does not bypass custody, signer state,
role checks, allowlists, audit, manual approval, or transaction inspection. Caps
On enforces the SOL row and every configured SPL token row. Existing wallets with
non-zero saved caps are treated as Caps On until the operator switches them Off.

Pending approvals include a compact diff showing what will spend, from which
wallet role, to which destination, and what source triggered it. The runtime also
stores the policy-simulation result so an operator can see whether the request is
passing policy, blocked, or waiting for manual approval.

Each pending approval also creates an audit record. Use Wallets recent activity
or the run/history surfaces to inspect the matching `wallet` record, policy
simulation, related marketplace/task ids when available, and final broadcast
result. The record is audit visibility only; approval and signing still happen
from Wallets.

### 6. Recent activity

This is the fastest way to confirm what the runtime actually did:

- request created
- request approved or rejected
- send executed or failed
- no unexpected outbound work

## Wallet types and assignments

There are three permanent wallet purposes in the product:

- Agent
- Mining
- Vault

Those purposes are stored on the wallet record and should not be changed after
creation. The current public wallet UI is Solana-only. Display name is only a
label; the permanent handle is `@wallet:<walletId>`.

Bond is not a wallet purpose. It is a Fased Network assignment that must point to a
Vault wallet.

### Agent wallet

This is the normal working role for:

- ordinary reviewed sends
- Fased Network wallet actions
- order evidence publication
- skill/plugin wallet tasks
- reviewed advanced wallet actions

You can have more than one Agent wallet. One Agent wallet can be marked primary; that is the fallback when an approved wallet action does not include an explicit handle. Other Agent wallets are still usable with their exact handles.

The wallet purpose stored on the wallet is Agent because it is the wallet the
agent is allowed to use for risky chat, skill, plugin, Fased Network, and
advanced wallet actions.

New wallets should be assigned explicitly during onboarding or CLI creation.
Legacy wallets without purpose metadata are manual-first until you create or
mark a proper Agent wallet. Do not repurpose Mining or Vault wallets into Agent
wallets.

The wallet name/id should describe purpose, not chain. Use `Agent` / `agent`; the UI shows the chain separately as `Solana`.

Use explicit handles for risky actions:

```text
@wallet:agent
```

Display names are hints only. They are not enough to execute a send, wallet action, or
scheduled wallet action. Use the exact `@wallet:<walletId>` handle or a
structured tool/API `walletId`.

Agent wallet actions from owner chat or allowed channels can execute
automatically when Auto is On and policy allows the action. This is not the same
as the Wallets page manual Send form. Manual Send creates a request in the Wallets
page; Agent wallet chat actions still use enabled caps, allowlists, balance
checks, transaction inspection, custody state, and audit logs before signing.

The same Agent wallet policy also gates advanced `wallet_action` chat flows and
scheduled wallet work. Those flows must name the Agent wallet handle or resolve
the configured primary Agent wallet; they never use Mining or Vault wallets as
advanced wallet-action sources.

Marketplace order actions and evidence also use Agent wallets only. If a user
buys an offer, handles an order, receives service receipts, or publishes order
evidence, the runtime should use an Agent wallet under policy. Mining wallets
are for Satcoin mining and SAT sweep. Vault wallets are protected/manual-first
and should not become Marketplace automation wallets.

Examples:

```text
Send 0.05 SOL to <address> from @wallet:agent
Every day at 9am prepare a reviewed wallet action from @wallet:agent.
```

For token names or symbols, the agent may resolve metadata from configured token
metadata sources. Symbol/name is accepted only when it resolves to one
unambiguous mint. If more than one token matches, use the exact mint.

Caps are edited in one table:

- open the Agent wallet
- open `Policy`
- open `Caps`
- switch Caps On only when you want limit enforcement
- set the `SOL` row for native SOL
- search or paste a token mint to add USDC, SAT, FCOD, or another SPL asset row
- set `Daily` and `Per tx` for that asset, then click `Save`

The UI stores caps by mint, not by token symbol. This keeps one SPL token from
reusing another token's cap accidentally.

If the wallet already holds the token, the Balance section also shows the token
with metadata and the same cap fields. If search is ambiguous, choose the exact
mint manually.

For advanced wallet-action details, use [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels)
and [Wallet selection contract](/plugins/crypto/wallet-selection-contract).

### Mining wallet

This is the dedicated Solana working wallet for:

- Satcoin miner readiness
- miner capital funding
- active commit
- claim
- post-claim sweep

Mining wallet automation is limited to Satcoin mining and configured SAT sweep.
It must not be used for Marketplace checkout, service receipts, chat sends,
plugin order actions, recurring transfers, or API/data-service subscriptions.

For unattended mining, use a background-ready self-hosted signer path. In practice that means `local-socket-signer` with `fased-signerd`, enough wallet SOL for fees, and the singleton `@wallet:mining` wallet instead of reusing the Agent wallet.

The runtime treats the active mining wallet as protected operational state. Do
not delete or repurpose it while mining is active.

To stop using a mining wallet: stop mining, let pending cycles clear, claim,
withdraw or sweep what you need, then delete that wallet through the guarded
wallet-management path if you no longer want it. Create a new Agent or Vault
wallet instead of changing the mining wallet purpose.

### Vault wallet

This is the manual-first wallet for:

- higher-friction outbound work
- hot or warm reserve behavior
- balances you do not want reused for routine automation
- Satcoin bond authority when selected for Fased Network bond

Vault wallets are reserve/custody wallets. They can receive funds manually and
can be selected for bond-related authority, but they should not run Marketplace
checkout, provider order actions, subscription renewal, chat automation, plugin order actions,
or scheduled task transfers. Vault can still have Caps for reviewed Wallets UI sends, but
Vault never gets Auto.

Policy, custody, and signer status records use `vault` for this purpose.

### Offline reserve outside the runtime

You should still keep an offline reserve or cold wallet outside Fased.

That matters more than inventing extra runtime labels.

## How wallets are created or imported

The normal public path is:

1. run onboarding or `fased wallet setup`
2. create or import a wallet
3. choose a permanent purpose and display label
4. configure RPC for the chain
5. let the runtime register the wallet
6. confirm the wallet appears in Wallet

Role defaults:

- onboarding asks for wallet purpose: Agent, Mining, or Vault
- onboarding lets you edit the wallet name once during creation; this is a display label only
- the permanent `walletId` and handle are generated from wallet purpose, not from the display name
- CLI creation/import marks a wallet Agent or Vault when you pass `--role agent` or `--role vault`
- one singleton Mining wallet is created or imported as `@wallet:mining`
- wallets with no Agent role behave like Vault/manual-first wallets for risky chat and skill actions
- existing wallet purpose is treated as permanent; create a new wallet instead of repurposing Mining, Agent, or Vault wallets
- onboarding reset does not delete wallet keystores or registry state under `~/.fased/wallet`
- wallet deletion is separate, per-wallet, and requires typing the exact wallet id after you save recovery material and move funds if needed

For production, use role/purpose ids without chain suffixes:

- `Agent` / `agent`
- `Mining` / `mining`
- `Vault` / `vault`

Only Agent and Vault are multi-wallet purposes. Duplicates get numeric ids:

- `Agent 2` / `agent-2`
- `Vault 2` / `vault-2`

Display names can still be user-friendly:

- display name `Operations`, role Agent, handle `@wallet:agent-2`
- display name `Cold`, role Vault, handle `@wallet:vault-2`

Use the handle in prompts and skill configuration:

```text
@wallet:agent
@wallet:agent-2
```

## Agent wallet actions and skills

Chat, skills, plugins, and schedules can use the bundled wallet-action path only
through Agent wallets and only when wallet policy allows it.

The Wallets page is where you see the resulting policy, approvals, activity, and
Skill Grants state. It is not the reference page for every wallet-action schema.

Use these docs for the deeper paths:

- [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels) for chat prompts, scheduled sends, and channel behavior
- [Wallet Roles and Policies](/plugins/crypto/wallet-roles-and-policies) for role boundaries and skill grants
- [Wallet selection contract](/plugins/crypto/wallet-selection-contract) for exact handles and caller fields

The important rule is simple: custom or installed skills cannot use Mining or
Vault wallets. They must use explicitly granted Agent wallets, and normal wallet
policy still checks role, caps, balance, signer state, transaction inspection,
and audit logging.

## How to fund a wallet

The basic funding path is simple:

1. open **Wallets**
2. copy the correct address from the wallet card
3. send assets in from your external wallet or exchange
4. refresh balances and confirm the funds arrived

Operational rules:

- keep every Solana working wallet funded with enough SOL for transaction fees
- keep the Agent wallet near working-capital size
- keep the mining wallet small except when you deliberately stage capital or claim activity
- use a Vault wallet for bond-related Satcoin
- move excess value back to vault or offline reserve on purpose

If a runtime wallet silently grows into treasury-sized balance, the operator model has already slipped.

## Self-hosted signer and lock model

The public self-hosted path is:

- wallet registry in the runtime
- provider id `local-socket-signer`
- native signer `fased-signerd`
- explicit chain RPC
- optional Wallet Control Passkey and split-key custody

The important distinction is:

- `local-socket-signer` is the provider id
- `fased-signerd` is the Go signer process
- `walletId` and `walletName` are your operator-facing identities
- `@wallet:<walletId>` is the explicit handle for chat, skill, plugin, and scheduled wallet actions

For the full architecture, storage paths, and security model, see [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted).

## Lock, unlock, and passkey

The conservative operator order is:

1. enable Wallet Control Passkey
2. enroll at least one passkey
3. use Agent `Stop` when you need to pause chat, skill, plugin, or scheduled wallet execution
4. turn on split-key security for Vault wallets that should require manual custody unlock
5. keep secured Vault wallets locked when idle, or unlock them until you manually lock them again

Passkey and split-key are not the same thing:

- passkey is the approval and ceremony layer
- split-key is the locked-wallet custody layer
- Agent `Stop` is an automation stop, not a split-key custody lock

For the step-by-step flows, see:

- [Wallet Control Passkey](/plugins/crypto/wallet-control-passkey)
- [Autonomous wallet security](/plugins/crypto/wallet-autonomous-security)
- [Autonomous wallet sessions](/plugins/crypto/wallet-autonomous-sessions)

## What Wallet should not be used for

Wallet should not become:

- a duplicate onboarding flow
- a duplicate mining page
- a duplicate bond lifecycle page
- a place to bypass send approval discipline
- a substitute for offline reserve or cold storage

Use the clean split:

- onboarding creates or imports wallets
- Wallet handles inventory, funding, approval, policy, and security
- Mining handles Satcoin runtime operations
- Fased Network handles bond posture and public network state

## CLI quick reference

```bash
fased wallet setup
fased wallet status --json
fased wallet signer doctor --json
fased wallet policy profile manual-owner
fased wallet custody-lock
```

## Related docs

- [Operator glossary](/start/operator-glossary)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Wallet Control Passkey](/plugins/crypto/wallet-control-passkey)
- [Mining](/plugins/crypto/mining-page)
- [Advanced Satcoin mining](/plugins/crypto/mining-advanced)
- [Satcoin mining API and protocol](/plugins/crypto/mining-protocol)
- [Fased Network guide](/start/federation)
- [Bond operator](/start/bond-operator-economy)
