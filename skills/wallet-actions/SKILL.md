---
name: wallet-actions
description: Use when the user asks Fased Agent to send, quote, swap, schedule, or place/cancel Jupiter Trigger limit orders with @wallet handles.
metadata: { "fased": { "emoji": "wallet", "requires": { "config": ["wallet.runtime.enabled"] } } }
---

# Wallet Actions

Use this skill for wallet tasks requested through chat, skills, plugins, or schedules.

## Core Rules

- Use `wallet_action` for quote, swap, scheduled wallet-action plans, scheduled send templates, and Jupiter Trigger limit orders.
- Use `wallet` only for status, address, balance, all visible assets, native send, and SPL send.
- For wallet status/balance answers, summarize in normal user units. Do not paste raw tool JSON or base units unless the user explicitly asks for raw/base values.
- For "all balances", "SPL balances", or "what tokens are in this wallet", call `wallet` with `action: "assets"` and summarize SOL plus visible SPL tokens.
- For native SOL sends, use human units with `"amountFormat": "human"` when the user says normal amounts like `0.1 SOL`.
- Destination wallet handles such as `@wallet:vault` are valid for native sends and resolve to that wallet's receive address.
- External destinations must be complete Solana addresses. If a user gives a malformed address for a Solana send, stop and ask for the correct Solana address.
- Swaps, limit orders, and custom/installed skill grants must use an Agent wallet.
- Native SOL/SPL sends and `schedule_send` must use an explicit Agent wallet handle when requested from chat, skills, plugins, or cron.
- Prefer explicit handles like `@wallet:agent`.
- Plain wallet display names are hints only. Do not execute from names like `Agent`, `Trading`, or `Solana 2`.
- Never expose SendAI, Solana Agent Kit, Jupiter, or raw signing tools directly to the model path.
- Mining wallets are SAT mining only and use the Mining SAT sweep policy, not generic wallet caps or scheduled-send policy.
- Vault wallets are manual storage and federation bond assignment only. Use the Wallet page approval flow for Vault sends.
- Direct owner chat can execute Agent wallet sends automatically when Agent wallet automation is enabled and caps allow it.
- Custom and installed skills need an explicit `walletActions` permission config before wallet actions are allowed.
- SOL caps apply only to native SOL. SPL token input requires a per-mint token cap before chat, schedule, or autonomous spending can run.
- Token symbols/names are convenience only. If ambiguous, ask for the exact mint.
- If route allowlists are configured, do not bypass them; report the blocked route program.
- Limit orders deposit funds into the Jupiter Trigger vault while the order is active. Always mention this before creating the live order.
- Do not recommend trades, promise outcomes, or present swaps/limit orders as profit, yield, or investment advice. Execute only user-specified wallet actions after policy checks.
- For DeFi, LP, strategy, recent transaction, or token-market questions, answer only from data returned by available tools. If there is no tool data for a pool, transaction history, or market source, ask for the exact mint/pool or say that live data is not available instead of inventing analysis.

## Balance And Assets

For a normal SOL balance question:

```json
{
  "action": "balance",
  "chain": "solana",
  "walletHandle": "@wallet:agent"
}
```

Summarize as normal SOL, for example: `@wallet:agent has 1.14994 SOL.`

For all visible Solana balances, including SPL tokens:

```json
{
  "action": "assets",
  "chain": "solana",
  "walletHandle": "@wallet:agent"
}
```

For one exact SPL token balance, use the token mint:

```json
{
  "action": "balance",
  "chain": "solana",
  "walletHandle": "@wallet:agent",
  "program": "<TOKEN_MINT>"
}
```

## Quote

For a quote, call:

```json
{
  "action": "quote",
  "walletHandle": "@wallet:agent",
  "inputToken": "SOL",
  "outputToken": "<symbol, name, or mint>",
  "amount": "0.1",
  "amountFormat": "human",
  "slippageBps": 50
}
```

Summarize the quote before any swap request. Include input, expected output, slippage, price impact, route label, and route program ids if returned.

## Swap

For a normal Agent wallet swap from owner chat, call:

```json
{
  "action": "swap",
  "walletHandle": "@wallet:agent",
  "inputToken": "SOL",
  "outputToken": "<symbol, name, or mint>",
  "amount": "0.1",
  "amountFormat": "human",
  "slippageBps": 50
}
```

This executes automatically only after wallet role, caps, policy, signer, and route checks pass. If the user explicitly asks for a review-only flow, add `"mode": "manual"` and tell them to approve or reject it in the Wallet page.

Do not retry with a different wallet, mint, amount, or slippage unless the user explicitly asks.

## Native Send

For a native SOL transfer between named wallets, call `wallet` with a human amount:

```json
{
  "action": "send",
  "chain": "solana",
  "walletHandle": "@wallet:agent",
  "to": "@wallet:vault",
  "amount": "0.1",
  "amountFormat": "human"
}
```

If the destination is external, use the raw destination address in `to`. If policy requires
manual approval, tell the user to review and approve it in the Wallet page.

For sell or token-to-token swaps, use exact mints unless the symbol is
unambiguous and the input mint has a configured token cap:

```json
{
  "action": "swap",
  "walletHandle": "@wallet:agent",
  "inputToken": "<input token mint>",
  "outputToken": "SOL",
  "amount": "100",
  "amountFormat": "human",
  "slippageBps": 50
}
```

## Scheduled Wallet Action

For a recurring swap task, first ask for missing details:

- exact wallet handle
- input mint and output mint
- amount per run
- schedule
- slippage limit
- whether it should create manual approvals or run autonomously

Then call `wallet_action` with `action: "schedule_plan"`. It returns a disabled cron job template.

Create the schedule with the `cron` tool only after the user approves the schedule. Keep the generated cron job disabled unless the user explicitly says to enable it.

Example:

```json
{
  "action": "schedule_plan",
  "walletHandle": "@wallet:agent",
  "inputToken": "SOL",
  "outputToken": "<symbol, name, or mint>",
  "amount": "0.1",
  "amountFormat": "human",
  "slippageBps": 50,
  "mode": "manual",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/Chicago" },
  "name": "Daily wallet swap"
}
```

For a recurring native SOL or SPL token send, call `wallet_action` with
`action: "schedule_send"`. It returns a disabled cron job template that uses the
native `wallet` tool at runtime. Caps, custody, direct-signing policy, external
Solana address validation, and per-mint token caps are checked again every run.
Add `"savePolicy": true` when the user wants the Wallet page and chat to share
the same recurring transfer policy for the Agent wallet. Mining wallets keep
the Mining SAT sweep policy only. Vault wallets stay manual-only and cannot save
generic recurring transfer policy. When a policy is saved, report
`savedPolicy.status`: `created`, `updated`, or `unchanged`.

Fixed native SOL example:

```json
{
  "action": "schedule_send",
  "walletHandle": "@wallet:agent",
  "chain": "solana",
  "to": "@wallet:vault",
  "amount": "0.1",
  "amountFormat": "human",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/Chicago" },
  "name": "Daily SOL transfer",
  "savePolicy": true
}
```

Fixed SPL token example:

```json
{
  "action": "schedule_send",
  "walletHandle": "@wallet:agent",
  "chain": "solana",
  "to": "<external Solana address or @wallet:vault>",
  "program": "<TOKEN_MINT>",
  "amount": "25",
  "amountFormat": "human",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/Chicago" },
  "name": "Daily token transfer",
  "savePolicy": true
}
```

Percentage sweep-style example:

```json
{
  "action": "schedule_send",
  "walletHandle": "@wallet:agent",
  "chain": "solana",
  "to": "@wallet:vault",
  "program": "<TOKEN_MINT>",
  "amountMode": "percentage",
  "percentage": 40,
  "minAmount": "1",
  "keepAmount": "10",
  "amountFormat": "human",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "America/Chicago" },
  "name": "Daily token sweep",
  "savePolicy": true
}
```

Create the schedule with the `cron` tool only after the user approves the
generated template. Keep it disabled unless the user explicitly says to enable
it. For percentage schedules, the cron run must read current wallet balance,
subtract `keepAmount`, apply `percentage`, skip when below `minAmount`, and then
send with `amountFormat: "base"`. Do not change the wallet, destination, mint,
amount, percentage, or schedule unless the user updates the job.

## Limit Orders

Use `limit_order` for Jupiter Trigger V2 single limit orders. Ask for missing:

- exact wallet handle
- input mint and output mint
- amount to deposit
- trigger condition: `above` or `below`
- trigger USD price
- expiry
- slippage limit

Live limit orders require Jupiter Trigger config on the host. Users can enable it
from onboarding with `Wallet setup action -> Limit orders`, or by running:

```bash
fased wallet limit-orders --enable --jupiter-api-key <jupiter-api-key>
```

Never ask the user to paste the Jupiter API key into chat. The key belongs in
local config env vars as `FASED_JUPITER_API_KEY`.

Review-only plan:

```json
{
  "action": "limit_order",
  "mode": "manual",
  "walletHandle": "@wallet:agent",
  "inputToken": "SOL",
  "outputToken": "<symbol, name, or mint>",
  "amount": "0.1",
  "amountFormat": "human",
  "triggerCondition": "below",
  "triggerPriceUsd": 120,
  "expirySeconds": 604800,
  "slippageBps": 100
}
```

Live order:

```json
{
  "action": "limit_order",
  "mode": "autonomous",
  "walletHandle": "@wallet:agent",
  "inputToken": "SOL",
  "outputToken": "<exact mint preferred>",
  "amount": "0.1",
  "amountFormat": "human",
  "triggerCondition": "below",
  "triggerPriceUsd": 120,
  "expirySeconds": 604800,
  "slippageBps": 100
}
```

Creating a live order signs a Jupiter Trigger auth challenge and a deposit transaction through Fased local signer. Fased checks Agent role, wallet policy, caps, token caps, input balance, expiry, and transaction shape before signing. Funds sit in the Jupiter Trigger vault until fill, expiry, or cancellation.

List active orders:

```json
{
  "action": "limit_history",
  "walletHandle": "@wallet:agent",
  "state": "active"
}
```

Cancel and reclaim:

```json
{
  "action": "limit_cancel",
  "walletHandle": "@wallet:agent",
  "orderId": "<order id>"
}
```

Cancellation is also signed through Fased local signer. Do not cancel a different order id than the one the user confirmed.

## Safety Notes

- Fased supports SOL-input, token-to-SOL, and token-to-token swap routing through the Fased wrapper.
- Fased supports Jupiter Trigger V2 limit order create, history, and cancel/reclaim through the Fased wrapper.
- Direct owner chat may run Agent wallet swaps automatically when wallet policy allows it.
- Direct owner chat may run native/SPL sends from explicit Agent wallet handles when wallet policy allows it.
- Custom and installed skills require explicit `walletActions` config before wallet actions are allowed.
- Installed ClawHub skills must come from an allowlisted registry before wallet actions are allowed.
- If quote, policy, token cap, balance, transaction inspection, route allowlist, or execution fails, stop and report the reason.
