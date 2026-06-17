---
summary: "Guide to Agent, Mining, Vault, wallet policy, chat handles, Marketplace actions, and mining use."
read_when:
  - You are deciding which wallet role to use for chat, Marketplace, mining, Vault, or skills
  - You need exact @wallet handle behavior and policy boundaries
title: "Wallet Roles and Policies"
---

# Wallet Roles and Policies

Wallets in Fased are not interchangeable. Each wallet has a permanent purpose,
a policy lane, and a different automation boundary.

The recommended operating model is:

```text
Agent wallet  = normal approved work, Marketplace order actions, skills, sends
Mining wallet = Satcoin mining actions and public mining history
Vault wallet  = protected storage and optional Fased Network bond authority
External addr = read-only balance checks or send destination, never a local source
```

## Role map

<CardGroup cols={2}>
  <Card title="Agent wallet">
    Use it for chat sends, Marketplace order actions, invoices, skill/plugin
    wallet actions, small working balances, and reviewed wallet actions.

    Keep Satcoin mining, Vault storage, and bond authority on their own lanes.
  </Card>
  <Card title="Mining wallet">
    Use it for Satcoin start, stop, fund, commit, withdraw, claim, sweep, and
    mining history.

    Keep Marketplace buying, ordinary chat sends, skills, and invoices on Agent
    wallets.
  </Card>
  <Card title="Vault wallet">
    Use it for manual-first storage, higher-value balances, recovery separation,
    and optional Fased Network bond assignment.

    Keep routine automation, Marketplace order actions, and mining on their own
    lanes.
  </Card>
  <Card title="External Solana address">
    Use it for read-only SOL/SPL balance checks or as a destination for
    manual/approved sends.

    External addresses are never local signing sources.
  </Card>
</CardGroup>

Bond is not a fourth wallet purpose. Fased Network bond authority is an
assignment that must point to a Vault wallet.

## How to enable

Use onboarding, wallet CLI, or the Wallets page:

1. Create or import an Agent wallet.
2. Set one Agent wallet as the primary Agent fallback if you want approved
   actions to have a default.
3. Create or import the singleton Mining wallet before SAT mining.
4. Create or import a Vault wallet for protected storage or Fased Network bond.
5. Enable chains and token caps in wallet runtime policy.
6. Enable protected custody or split-key/passkey flows for wallets that require
   stronger unlock.
7. Keep the Agent wallet funded only for the amount of work it is allowed to do.

The primary Agent wallet is only a fallback. Exact wallet requests should use
the handle.

```text
@wallet:agent
@wallet:agent-1
@wallet:mining
@wallet:vault
```

## Chat behavior

Chat wallet requests should be precise.

Use exact local handles:

```text
Show all balances for @wallet:agent.
Show SOL and SPL assets for @wallet:agent-1.
Show all balances for @wallet:mining.
Show the vault SOL balance for @wallet:vault.
```

Read-only wallet actions can target Agent, Mining, or Vault handles. They should
not fall back to `solana-1` or any other default when a handle is present.

External Solana addresses are read-only balance targets:

```text
Show SOL and SPL balances for 4ey8zYsSo9...nfXWVg5g.
```

Risky actions are narrower:

- `prepare` and `send` require an Agent wallet source
- advanced wallet actions, recurring wallet-action plans, and scheduled sends use
  the Agent-only `wallet_action` tool
- Mining and Vault wallets are rejected as chat automation sources
- destination can be a raw address or a receive handle like `@wallet:vault`
- policy still checks chain, token, amount, direct signing, skill permission,
  custody state, and approval path

Example:

```text
Send 0.1 SOL from @wallet:agent to @wallet:vault.
```

This resolves the Agent wallet as the source and the Vault wallet as the receive
address. It does not make the Vault wallet an automation source.

## Manual send in Wallets

The Wallets page should be treated as the operator control surface.

Use it when you need:

- a visible source wallet selector
- balances per wallet handle
- manual review before a send
- destination as `@wallet:<id>` or an external address
- custody unlock prompts
- transaction records and approval state

Manual send can pick from local wallet handles. External addresses remain valid
destinations.

For chat and channel examples, see [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels).

## Marketplace use

Marketplace order actions use the Agent wallet.

Buyer flow:

1. Buyer starts checkout from a Marketplace listing.
2. No funds move at checkout start.
3. Buyer clicks Pay.
4. Agent wallet sends to the seller payee address under wallet policy.
5. Order records tx, invoice, receipt, order evidence, delivery, and result.
6. Seller Sales receives the inbound order envelope and validates evidence.

Seller flow:

1. Seller publishes an offer backed by a real manual or automated service path.
2. Seller Agent wallet or configured payee receives the order funds.
3. Seller Sales shows invoice, receipt, order evidence, and delivery state.
4. Reviews or disputes reference saved evidence.

Mining wallets and Vault wallets are not Marketplace order-action wallets.

## Skills, plugins, and automation

Skills and plugins may request wallet actions, but policy decides what is
allowed.

Current policy boundary:

- skills can see wallet tools only through the selected Agent's tool surface
- risky wallet actions require a wallet action manifest or explicit allowlist
- skill origin and registry allowlists can reject wallet access
- wallet policy caps still apply even when a skill is approved
- disabled skills cannot use wallet tools
- skills can request optional route actions, schedule plans, scheduled sends, and
  trigger-order actions only when their wallet action grant includes those actions
- custom, workspace, and catalog-installed skills cannot use Mining or Vault
  wallets; only the built-in Satcoin mining runtime and bundled SAT mining skill use the
  `@wallet:mining` path

Target behavior for future personas:

- skills inherit wallet access only through an approved persona or tool policy
- each persona can define allowed wallets, assets, routes, max spend, cadence,
  data sources, and approval requirements
- personas should make wallet authority easier to reason about, not broader
  than the current Agent-only wallet action grants
- data skills can inform a wallet action, but they do not bypass wallet policy

## Advanced and scheduled wallet actions

Advanced and scheduled wallet work should use the Agent wallet and clear policy.

Supported action shapes:

- reviewed sends
- autonomous sends when Agent policy allows them
- invoice or order action
- scheduled sends
- Marketplace order action
- skill/plugin wallet task with manifest permissions
- inspected token-action routes
- reviewed trigger-order actions when configured
- recurring wallet-action plans through Tasks and `wallet_action.schedule_plan`
- event-triggered wallet actions under explicit policy

Maturing action shapes:

- persona-reviewed wallet plans
- recurring Marketplace subscriptions

Required policy for automation:

- allowed wallet role: Agent
- allowed chain and asset
- max amount per action and period
- allowed destination or venue
- approval mode
- schedule or trigger source
- receipt storage
- emergency stop

## Mining use

Mining uses the Mining wallet, the Mining page, and the dedicated chat handle:

```text
@mining
```

Supported command examples:

```text
Check @mining status and readiness.
Start @mining with @wallet:mining.
Stop @mining.
Deposit 1 SOL into @mining capital.
Set @mining commit to 0.5 SOL.
Claim @mining for cycle 123.
Ask @mining to analyze strategy from my history.
```

Scheduled and conditional mining uses isolated Task agent turns. The scheduled
message can ask the agent to read mining status/history and then call the
mining tool when thresholds match.

Examples:

```text
Stop @mining if pool capital is above 100 SOL and miner count is above 10.
Start @mining when miner count drops below 10.
Every cycle, analyze @mining history and set the best strategy before submit.
```

See [Mining Chat and Automation](/plugins/crypto/mining-chat-and-automation)
for the full action map.

## Vault and split-key custody

Vault is the protected lane.

Use Vault for:

- higher-value balances
- manual-first storage
- recovery separation
- optional Fased Network bond authority
- receiving funds from the Agent wallet

Split-key or passkey custody can lock a wallet until the required unlock flow is
completed. A locked split-key Agent wallet cannot pay Marketplace orders until
custody is unlocked. A locked Vault should not be silently downgraded into a
normal automation wallet.

Good error behavior is explicit:

```text
Wallet is locked by split-key custody.
Unlock the selected wallet and retry.
No funds were moved.
```

## Scenario guide

**Ask for all balances**

Wallet: any local handle or external Solana address. Surface: Chat or Wallets.

**Manual send**

Wallet: Agent source, with a local handle or external destination. Surface:
Wallets page.

**Marketplace purchase**

Wallet: Agent. Surface: Marketplace or chat-assisted checkout.

**Seller receipt**

Wallet: seller Agent/payee. Surface: Marketplace Sales.

**Skill wallet action**

Wallet: Agent, with skill wallet policy. Surface: Chat, skill, or schedule.

**SAT mining**

Wallet: Mining. Surface: Mining page and `@mining` chat tools.

**Fased Network bond**

Wallet: Vault assignment. Surface: Fased Network page.

**Vault storage**

Wallet: Vault. Surface: Wallets page/manual flows.

**Advanced wallet actions**

Wallet: Agent. Surface: Chat/channel `wallet_action` plus Tasks.

**External Solana balance**

Wallet: external address. Surface: Chat read-only.

## Read next

- [Wallet](/plugins/crypto/wallet-page)
- [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels)
- [Mining Chat and Automation](/plugins/crypto/mining-chat-and-automation)
- [Wallet Selection Contract](/plugins/crypto/wallet-selection-contract)
- [Wallet Autonomous Security](/plugins/crypto/wallet-autonomous-security)
- [Mining](/plugins/crypto/mining-page)
- [Offers and Marketplace](/start/offers-marketplace)
