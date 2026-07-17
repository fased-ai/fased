---
summary: "What to test after wallet, Marketplace, mining, and channel-control changes."
read_when:
  - You rebuilt the agent and want to smoke-test wallet and mining controls
  - You need a checklist for Marketplace purchase/sale refresh behavior
  - You want to verify Chat and paired channels use the same policy gates
title: "Wallet, Mining, and Marketplace Test Guide"
---

# Wallet, Mining, and Marketplace Test Guide

Use this checklist after pulling, rebuilding, and restarting the agent and UI.
Run live transfers only on wallets and networks you intentionally control.

## 1. Wallet balance reads

In Chat, verify exact wallet handles do not fall back to a legacy default:

```text
Show every local wallet balance.
Show all balances for @wallet:agent.
List SOL and SPL assets for @wallet:mining.
Show the Vault wallet address and balance for @wallet:vault.
Show SOL and SPL assets for <external-solana-address>.
Show balance for <external-solana-address>.
```

Expected result:

- `@wallet:agent` returns the Agent wallet, not `solana-1`
- `@wallet:mining` returns the Mining wallet and assets
- `@wallet:vault` is read-only unless an explicit Vault operation supports it
- exact wallet-handle reads do not also dump every local wallet
- exact external Solana address reads do not also dump Agent, Vault, or local wallets
- address and balance reads do not require the user to say `chain=solana`
- local wallet balance lists show the handle naturally, without a `walletHandle:` label
- SOL amounts are shown as SOL, not lamports

## 2. Wallets page send flow

Open Wallet and test the manual send modal:

1. Select a source by handle or wallet name, for example `@wallet:agent`.
2. Send to a local receive handle such as `@wallet:vault`, or a raw external address.
3. Create an approval request first.
4. Reject one request to confirm the approval path.
5. For a real smoke, approve only a tiny SOL or token transfer.

Expected result:

- source selector lists local wallets with role handles
- Agent wallet can create ordinary sends
- Mining and Vault wallets are blocked as generic chat/send sources
- approval, execution, failure, and activity rows use human units

## 3. Chat sends and reviewed wallet actions

Use Chat prompts that force policy checks:

```text
Prepare, but do not send, 0.001 SOL from @wallet:agent to @wallet:vault.
Send 0.001 SOL from @wallet:agent to @wallet:vault.
Create a route quote for 0.01 SOL to USDC from @wallet:agent.
Create a reviewed route-action quote for 0.01 SOL to USDC from @wallet:agent.
Create a disabled recurring wallet-action review for 0.01 SOL to USDC from @wallet:agent daily.
Prepare a reviewed route action of 0.01 SOL to USDC from @wallet:agent.
Create a disabled limit-action review for 0.01 SOL to USDC from @wallet:agent when SOL is below the configured threshold.
```

Expected result:

- manual mode creates an approval instead of signing
- Auto mode signs only when Agent-wallet policy, caps, token caps, custody, and signer health pass
- SPL sends without a matching token cap are rejected
- decimal route or quote amounts, for example `0.01`, are treated as human SOL units
- scheduled work is created disabled until reviewed
- limit-action reviews remain review-only until the policy and prompt explicitly
  allow live execution
- recurring wallet-action reviews create disabled scheduled tasks until reviewed

## 4. Marketplace buyer and seller smoke

Open Marketplace and test a full refresh-stable purchase:

1. Search public offers.
2. Open a `content.summarize` offer.
3. Start checkout and run only a tiny intentional SOL order action.
4. Keep checkout open until tx, invoice, receipt, evidence, delivery, and result appear.
5. Refresh the buyer page.
6. Confirm Purchases still shows old and new purchases.
7. Open the seller node and refresh.
8. Confirm Sales shows the inbound order with receipt and order evidence.

Chat checks:

```text
Find @offers for Twitter API access.
Show my Marketplace purchases.
Show Marketplace order evidence.
Show Marketplace sales waiting for delivery.
```

Expected result:

- buyer Purchases does not disappear on page load or refresh
- seller Sales receives inbound orders with order evidence
- `@offers` searches Marketplace data, not the public web
- order-evidence prompts return Marketplace invoice/receipt/tx evidence records
- Agent > Tasks shows a Marketplace order record with wallet action,
  delivery, receipt, and dispute steps
- titles show human offer/service labels, not raw service ids
- order-action failures keep checkout state visible and explain the exact wallet or policy issue

## 5. Mining chat controls

Use `@mining` for mining operations, not generic wallet sends. These prompts
route through the dedicated mining tool and the same Gateway methods used by the
Mining page and the mining CLI:

```text
Check @mining readiness.
Show @mining status.
Show @mining history for the last 24 hours.
Set @mining strategy to balanced deterministic.
Ask @mining to analyze strategy from my recent history.
Start @mining with @wallet:mining.
Stop @mining.
```

Capital operations should be tiny and intentional:

```text
Deposit 0.01 SOL into @mining capital.
Set @mining active commit to 0.01 SOL.
Withdraw 0.01 SOL from @mining capital.
```

Expected result:

- `@mining` reports profile, readiness, status, and history
- the singleton `@wallet:mining` wallet can run mining-specific operations
- start and stop use `sat.startMining` / `sat.stopMining`, then report the
  post-command status
- start reports success only when the returned status confirms mining is running
- stop reports success only when the returned status confirms mining is stopped,
  or reports drain mode when locked capital or pending cycles remain active
- the Mining page refreshes immediately after chat, channel, or Task `@mining` changes
- if the runtime did not actually become active, chat says that instead of claiming mining started
- Mining wallet is rejected for ordinary Marketplace, advanced wallet-action,
  and chat-send operations
- strategy analysis can read own mining history and pool history
- strategy analysis does not spawn an unrelated sub-agent or ask for a gateway token

## 6. Mining CLI parity

The CLI should behave like chat and the Mining page. The operator command is
the installed `fased` binary. If `fased` is missing, rerun `./install.sh
--no-onboard` from the repo checkout before testing this section.

```bash
fased mining wallets
fased mining readiness --wallet mining
fased mining status
fased mining start --wallet mining
fased mining status
fased mining history --window 24h
fased mining stop
fased mining status
```

Capital and commit smoke commands:

```bash
fased mining deposit-capital --sol 0.01
fased mining set-commit --sol 0.01
fased mining withdraw-capital --sol 0.01
```

Expected result:

- `fased mining start` calls `sat.startMining` and waits for the final Gateway result
  before printing success
- start prints success only when `started=true`, `running=true`, and the runtime
  is not in drain-only mode
- `fased mining stop` calls `sat.stopMining` and waits for the final Gateway
  result before printing success
- stop prints a drain/recovery message instead of a hard stopped message when
  locked capital or pending cycles remain active
- `--json` prints the raw Gateway payload for scripts and debugging
- the Mining page should reflect the same state after a refresh or live
  `mining.changed` event

## 7. Conditional mining automation

Create disabled scheduled tasks first. Suggested prompts:

```text
Every hour, check @mining status. Stop @mining if the pool has more than
100 SOL and more than 10 miners. Start again when miners drop below 10.
```

```text
Every cycle, ask @mining to analyze recent results and update strategy only if the recommendation changes.
```

Expected result:

- scheduled task starts disabled for review
- isolated session target is used
- thresholds and wallet handles are explicit
- enabling the task does not bypass mining wallet policy
- scheduled task start/stop behavior matches chat and CLI: no success claim unless status
  confirms it

## 8. Channel parity

From each paired channel you use, such as Telegram or WhatsApp, run the same
read-only prompts first. Channel control supports both explicit slash commands
and handle-style chat commands:

```text
@mining status
stop @mining
start @mining with @wallet:mining

/wallet list
/wallet balances
/wallet balance @wallet:agent
/wallet assets @wallet:mining
/wallet address @wallet:vault
/wallet send 0.001 SOL from @wallet:agent to @wallet:vault
/wallet quote 0.01 SOL to USDC from @wallet:agent

show balance for @wallet:agent
Show all balances for @wallet:agent.
Show every local wallet balance.
Show the Vault wallet address for @wallet:vault.
Send 0.001 SOL from @wallet:agent to @wallet:vault.
Create a route quote for 0.01 SOL to USDC from @wallet:agent.
Create a reviewed route-action quote for 0.01 SOL to USDC from @wallet:agent.

/trade quote 0.01 SOL to USDC from @wallet:agent
/trade limit orders @wallet:agent
/trade cancel limit <order-id> from @wallet:agent

/offers find content summary
/offers order evidence
/offers orders
Find @offers for data lookup.
Show Marketplace order evidence.
Show Marketplace purchases.
Show Marketplace sales waiting for delivery.

Check @mining status.
```

Expected result:

- paired channel user must be authorized
- Telegram, WhatsApp, Slack, Discord, and other paired channels use the same
  shared command router
- channel commands use the same mining, wallet, and Marketplace tools and
  policy gates as Chat
- `/trade` compatibility commands use `wallet_action`; they do not bypass
  Agent-wallet caps, custody, route inspection, route-action config, or
  approval policy
- Advanced wallet-action commands create disabled scheduled tasks until reviewed
- unauthorized channel users are rejected
- approvals still happen in Wallet when required
- generic Marketplace search uses `@offers` or `/offers`; plugin/skill
  marketplace commands stay under their own plugin/skill command surfaces
- natural language that is not an explicit handle/slash command still falls back
  to the normal agent path

## 9. Failure cases

Deliberately test blocked failures:

- unknown wallet handle, for example `@wallet:missing`
- external address used as a source wallet
- Mining wallet used for a normal send
- Vault wallet used for a normal send
- SPL send with no token cap
- Agent signer policy/RPC/WebAuthn state not ready for the requested reviewed operation
- bad payee address
- expired Marketplace token

Expected result: no funds move, the UI or chat answer explains the exact failed
gate, and the previous Purchases/Sales table remains visible after refresh.
