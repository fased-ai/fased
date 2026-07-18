---
summary: "Control wallets from Chat and paired channels with exact @wallet handles and normal wallet policy."
read_when:
  - You want to ask balances or send from a wallet in chat
  - You want channel commands to use the same wallet policy as the Control UI
  - You are setting up wallet automation, reviewed wallet actions, or Marketplace search from chat
title: "Wallet Chat and Channels"
---

# Wallet Chat and Channels

Wallet chat control uses the same agent tool surface in Chat, Telegram,
WhatsApp, Discord, Slack, and other paired channels. A channel message does not
get a separate wallet bypass. It runs through the same allowlists, owner checks,
wallet role checks, caps, custody state, token caps, route inspection, and audit
log used by the Control UI.

## Exact wallet handles

Use exact handles whenever the wallet matters:

```text
@wallet:agent
@wallet:agent-1
@wallet:mining
@wallet:vault
```

For balance and asset reads, the runtime honors the handle you ask for. It
should not silently fall back to a legacy wallet such as `solana-1` when the
message includes `@wallet:agent`, `@wallet:mining`, or any other exact handle.

Good balance prompts:

```text
Show all balances for @wallet:agent.
Show every local wallet balance.
List SOL and SPL assets for @wallet:mining.
Show the Vault wallet address and balance for @wallet:vault.
Show SOL and SPL assets for 4ey8zYsSo9...nfXWVg5g.
```

Supported read targets:

**`@wallet:<id>`**

Address, status, native balance, and SOL/SPL assets.

**All local wallets**

Wallet list and per-wallet balances/assets.

**External Solana address**

Read-only SOL/SPL balance and assets.

External addresses can be destinations or read-only balance targets. They are
not local signing sources.

## Sends

Only Agent wallets can be chat automation sources for ordinary sends.

Examples:

```text
Send 0.05 SOL from @wallet:agent to @wallet:vault.
Send 10 USDC from @wallet:agent to <external-solana-address>.
Prepare, but do not send, 0.01 SOL from @wallet:agent to @wallet:vault.
```

Destination can be a raw address or a local receive handle. Source must be an
Agent wallet for ordinary sends. Mining and Vault wallets are deliberately
rejected as generic chat-send sources.

Every send still checks:

- Agent wallet role
- chain and asset policy
- SOL caps or exact SPL mint caps
- destination allowlists when configured
- Auto/direct-signing setting
- signer policy/WebAuthn state and exact reviewed-authorization requirements
- signer health
- audit logging

If policy requires review, chat creates an approval request instead of signing.
The operator completes approval in Wallet.

## Reviewed wallet actions and scheduled sends

Reviewed wallet actions and recurring wallet work use the `wallet_action` tool.
They are Agent-wallet only.

For this page, the important behavior is:

- exact `@wallet:<id>` source handles are required when the source matters
- scheduled work starts as a disabled Task template
- the operator reviews the Task before enabling it
- the Agent wallet signs only when caps, token caps, route inspection, custody,
  and skill policy allow it

This means a data skill can inform a wallet action, but it does not receive raw
wallet authority. For action names, schemas, and advanced examples, read
[Wallet selection contract](/plugins/crypto/wallet-selection-contract).

## Skills and wallet actions

Wallet-capable skills are available through the normal agent tool surface, but
risky wallet actions require an explicit grant.

Use **Wallets > Skill Grants** for normal wallet-skill setup:

1. Install or review the skill from **Agent > Skills** for the selected Agent.
2. Open **Wallets > Skill Grants**.
3. Select the reviewed wallet-capable skill.
4. Grant only the needed Agent wallet ids, chains, exact token mints, actions,
   amount caps, and automation flags.

The CLI helper writes the same grant for scripted/admin setup. Keep grants narrow:
specific Agent wallet ids, chains, action names, exact mints, amount caps, and
automation flags.

Rules:

- disabled skills cannot use wallet tools
- skills cannot use Mining or Vault wallets as sources
- only the built-in Satcoin mining runtime and bundled SAT mining skill use the
  Mining wallet path
- each Agent wallet id must be explicitly granted before a wallet-capable skill
  can use it
- symbols are not authority for execution; exact mints are
- installed marketplace skills must come from an allowlisted registry when they
  request wallet actions
- wallet caps still apply even if a skill has a grant

## Marketplace from chat

Marketplace chat uses `@offers`-style discovery through the marketplace tool and
draft tools.

Examples:

```text
Find @offers for Twitter API access.
Search @offers for content.summarize.
Show my Marketplace order evidence and receipts.
Draft an offer for a webhook-delivered data lookup service.
Draft a buyer request for a weekly research report.
```

Implemented chat actions:

**Search offers/requests**

Use `marketplace` with `action="search"`.

**List local offers**

Use `marketplace` with `action="local_offers"`.

**List local requests**

Use `marketplace` with `action="local_requests"`.

**List orders**

Use `marketplace` with `action="orders"`.

**List payment evidence**

Use `marketplace` with `action="paid_invoices"`.

**Create offer draft**

Use `marketplace_offer_draft`.

**Create request draft**

Use `marketplace_request_draft`.

Order actions still use the Agent wallet and the adapter for that service kind.
Chat search does not bypass checkout, wallet policy, seller evidence checks, or
delivery rules.

## Channel safety

Channel control works when the sender and channel are allowed by the channel
configuration. A channel message that asks for a send, wallet action, or
`start @mining` still runs through owner/allowlist checks and tool policy.

For group channels, use normal channel controls:

- mention gating or trigger prefixes
- group allowlists
- per-channel session isolation
- explicit task targets for announcements

Treat chat and channels as the command surface. Treat Wallet, Mining, and
Marketplace as the review and evidence surfaces.

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Wallet Roles and Policies](/plugins/crypto/wallet-roles-and-policies)
- [Skills](/tools/skills)
- [Scheduled Tasks](/automation/cron-jobs)
- [Offers and Marketplace](/start/offers-marketplace)
- [Mining Chat and Automation](/plugins/crypto/mining-chat-and-automation)
