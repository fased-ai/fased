---
summary: "Stable wallet-selection rules for skills, plugins, mining helpers, and automation."
read_when:
  - You are building a skill or plugin that must choose the right wallet
  - You want deterministic wallet routing instead of fallback guesswork
title: "Wallet selection contract"
sidebarTitle: "Wallet selection"
---

# Wallet selection contract

This page defines how Fased chooses a wallet for:

- skills
- plugins
- automation
- mining-adjacent runtime actions

The goal is deterministic routing.
Runtime code should not guess which wallet to use when the request is ambiguous.

## 1. Provider versus wallet

`local-socket-signer` is a provider id, not a wallet name.

That distinction matters:

- provider id tells the runtime which signing backend is responsible
- wallet id tells the runtime which wallet entry to use

For the public self-hosted path, `local-socket-signer` is the main signer-backed provider.

## 2. Selection precedence

Read-only lookup may use:

1. exact `walletId`
2. `walletName` plus `providerId` when needed to disambiguate
3. explicit Agent assignment
4. Default Agent wallet

If `walletName` is ambiguous and the request does not supply a stronger
selector, the runtime should fail.

Risky chat, skill, plugin, and automation actions are stricter and resolve in
this order:

1. explicit `walletHandle` such as `@wallet:agent`, or structured `walletId`
2. one exact wallet ID in the calling skill's approved wallet grant
3. the calling Agent's explicit wallet assignment
4. the optional Default Agent wallet

For those actions, `walletName` is display-only and cannot authorize execution.
Agent wallets are the execution path for generic chat, skill, plugin, scheduled
send, and route actions. Vault wallets stay reviewed/manual through the Wallets
page. Mining wallets stay on the SAT mining and SAT sweep path.

Multiple Agent wallets are allowed. The Default Agent wallet is only the final
fallback and is never selected automatically during create/import. Exact
handles such as `@wallet:agent` or `@wallet:agent-2` select a specific Agent
wallet.

Onboarding and CLI creation mark the wallet purpose. Existing wallet purpose
should be treated as permanent for normal operator use.

## 3. Recommended caller fields

Preferred:

- `walletHandle` for risky chat/skill/plugin actions
- `walletId`

Acceptable when necessary:

- `walletName`
- `providerId`

Optional:

- `chain`
- `agentId` so the runtime can honor the calling Agent's assignment

The strongest production rule is:

- use `@wallet:<walletId>` in prompts and skill instructions
- use structured `walletId` in API/tool payloads
- pass the real calling `agentId`; never substitute the default Agent identity
- use `walletName` for display only

## 4. Examples

### Status by wallet id

```json
{ "action": "status", "walletId": "agent" }
```

### Balance by wallet name plus provider

```json
{
  "action": "balance",
  "chain": "solana",
  "walletName": "Vault",
  "providerId": "local-socket-signer"
}
```

### Send with explicit Agent wallet handle

```json
{
  "action": "send",
  "chain": "solana",
  "walletHandle": "@wallet:agent",
  "to": "So1anaAddress...",
  "amount": "1.25",
  "amountFormat": "human"
}
```

Plain prose such as “send from my other wallet” is not enough to execute. The
agent may ask a follow-up question, show the matching wallet, or require an
explicit `@wallet:<walletId>` handle.

`@wallet:vault` is valid as a destination. It is not valid as a chat, skill,
plugin, or scheduled task source wallet.

### Advanced or scheduled wallet action

Use the `wallet_action` tool for quotes, optional route actions, scheduled
planning, scheduled native/SPL transfer templates, and trigger-order actions:

```json
{
  "action": "swap",
  "walletHandle": "@wallet:agent",
  "inputMint": "So11111111111111111111111111111111111111112",
  "inputSymbol": "SOL",
  "outputMint": "TokenMint...",
  "outputSymbol": "TOKEN",
  "amount": "0.1",
  "amountFormat": "human",
  "slippageBps": 50
}
```

An Agent wallet request can execute only when wallet role, Auto policy, positive
per-transaction and daily signer caps, signer state, balance, and semantic
transaction inspection allow it. Caps Off, missing, or zero means deny, never
unlimited. Use `"mode": "manual"` when the user wants a review-only request;
manual native execution also requires signer WebAuthn for the exact review.
Custom or installed skills need explicit `walletActions` config before wallet
actions are allowed.

Every executable native asset policy requires caps. SOL and SPL assets use
separate positive cap rows; SOL caps never apply to SPL tokens.

For recurring native/SPL sends, `wallet_action.schedule_send` can save the same
Agent-wallet recurring transfer policy that the Wallets page edits. Mining
wallets do not accept this generic policy because their automated movement is
the Mining SAT sweep policy. Vault wallets do not accept it because they are
manual-only.

In the Wallets page, open the Agent wallet `Policy` section, then open `Caps`.
SOL and token rows are edited in the same table. You can search by symbol/name
to fill metadata, but ambiguous results must be resolved by exact mint. The
saved policy is mint-keyed; token symbols and names are display hints only.

```json
{
  "wallet": {
    "runtime": {
      "policy": {
        "solana": {
          "maxPerTx": "1000000000",
          "maxDaily": "5000000000",
          "allowPrograms": ["RouteProgramId..."],
          "tokenCaps": {
            "TokenInputMint...": {
              "maxPerTx": "100000000",
              "maxDaily": "500000000"
            }
          }
        }
      }
    }
  }
}
```

Symbol or name lookup is only a convenience. If the symbol/name is ambiguous,
the agent must ask for the exact mint. The mint address is the authority.

`allowPrograms` must list the exact inspected route program ids. An empty list
denies route execution; it never means allow all.

### Trigger order with explicit Agent wallet handle

Live trigger orders require the configured route-action adapter on the host.
The current Solana adapter is configured through the Jupiter Trigger setting.
Enable it from onboarding with `Wallet setup action -> Limit orders`, or from CLI:

```bash
fased wallet limit-orders --enable
```

Enter the Jupiter API key only at the interactive secret prompt. Do not place it
in shell arguments/history, chat, skill prompts, plugin prompts, or scheduled
job text.

```json
{
  "action": "limit_order",
  "mode": "autonomous",
  "walletHandle": "@wallet:agent",
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "TokenMint...",
  "amount": "0.1",
  "amountFormat": "human",
  "triggerCondition": "below",
  "triggerPriceUsd": 120,
  "expirySeconds": 604800,
  "slippageBps": 100
}
```

Fased creates Jupiter Trigger V2 orders only through the Agent wallet wrapper.
The wrapper authenticates by signing a challenge, crafts and signs the deposit
transaction, checks caps and input balance, records the order in audit history,
and returns the adapter order id. Funds sit in the route adapter's vault while
the order is active.

List or cancel active orders with the same explicit handle:

```json
{ "action": "limit_history", "walletHandle": "@wallet:agent", "state": "active" }
```

```json
{ "action": "limit_cancel", "walletHandle": "@wallet:agent", "orderId": "<order id>" }
```

Limit cancellation signs the withdrawal transaction through the local signer.
Do not expose the Jupiter Trigger API directly to the model path.

### Mining-adjacent wallet call

```json
{
  "action": "status",
  "walletId": "mining"
}
```

## 5. Multi-wallet signer mappings

Each native wallet id maps to one signer-owned wallet record, permanent role,
versioned policy, encrypted RPC configuration, and public address. Protocol-v2
execution does not select a Node keystore path or trust per-wallet Gateway RPC
environment variables.

Create/import and configure each wallet through the native control socket, then
register the exact returned `walletId` and address in the runtime registry. A
wallet-id/address collision fails closed. Signer health must acknowledge that
wallet's policy and network hashes before execution.

## 6. Policy and source controls

Wallet routing does not bypass policy.

Final access still depends on runtime controls such as:

- tool-access mode
- allowed agents
- allowed skills
- allowed sources
- per-wallet policy limits

So the contract is two-stage:

1. choose the wallet deterministically
2. enforce whether the caller is allowed to use it

Third-party Solana agent kits should sit behind Fased-owned wrappers. Those
wrappers run wallet selection, role checks, caps, allowlists,
approval/passkey/custody, and audit logging before signing.

Skill-level wallet action permissions live under the skill config object.
Normal setup starts in **Agent > Skills** for install/review, then uses
**Wallets > Skill Grants** so the operator can compare reviewed plugin-catalog
permission requests against the actual grant before saving.

The CLI helper generates the same block for scripted/admin setup:

```bash
fased skills wallet grant wallet-actions \
  --registry https://clawhub.com \
  --actions quote,swap,schedule_plan,schedule_send \
  --actions limit_order,limit_history,limit_cancel \
  --role agent \
  --wallet-id agent \
  --chain solana \
  --input-mint So11111111111111111111111111111111111111112 \
  --output-mint <TOKEN_MINT> \
  --max-amount 100000000 \
  --max-slippage-bps 50 \
  --autonomous \
  --cron
```

```json
{
  "skills": {
    "marketplace": {
      "allowRegistries": ["https://clawhub.com"]
    },
    "entries": {
      "wallet-actions": {
        "config": {
          "walletActions": {
            "actions": [
              "quote",
              "swap",
              "schedule_plan",
              "schedule_send",
              "limit_order",
              "limit_history",
              "limit_cancel"
            ],
            "roles": ["agent"],
            "walletIds": ["agent"],
            "chains": ["solana"],
            "registries": ["https://clawhub.com"],
            "inputMints": ["So11111111111111111111111111111111111111112"],
            "outputMints": ["TokenMint..."],
            "maxAmount": "100000000",
            "maxSlippageBps": 50,
            "autonomous": true,
            "cron": true
          }
        }
      }
    }
  }
}
```

When a skill is installed from the plugin catalog, Fased reads `<workspace>/skills/<id>/.clawhub/origin.json`
and rejects wallet actions unless the recorded registry is allowlisted. Local
owner chat is separate; this gate is for skill-initiated wallet tool use.
Mining and Vault wallet roles are still rejected for custom or catalog-installed skills;
only the built-in Satcoin mining runtime and bundled SAT mining skill operate
through the Mining wallet path.

## 7. Practical guidance

For production operator setups:

- give each economic role a dedicated wallet id
- never rely on display name alone in automation
- keep Agent, mining, and vault separated
- select the bond Vault explicitly through Fased Network config
- fail closed on ambiguity

Related pages:

- [Wallet](/plugins/crypto/wallet-page)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Mining](/plugins/crypto/mining-page)
- [Fased Network Guide](/start/federation)
