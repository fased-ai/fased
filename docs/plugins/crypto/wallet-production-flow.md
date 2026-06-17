---
summary: "Wallet operating guide for setup, funding, roles, policy, passkey, custody, and sweeps."
read_when:
  - You want the full wallet operating model after onboarding
  - You are validating wallet behavior for order actions, mining, Fased Network, or plugins
title: "Wallet operations and security"
sidebarTitle: "Wallet security"
---

# Wallet operations and security

This is the operator guide for wallets in Fased.

Use it as the contract between:

- onboarding and CLI setup
- the self-hosted signer
- Wallets UI behavior
- mining and Fased Network use of wallets
- policy, approval, and security controls

For the page walkthrough, start with [Wallet](/plugins/crypto/wallet-page).

## The short version

The recommended public wallet model is:

- one or more Agent wallets, with one primary fallback
- one mining wallet
- one or more Vault wallets
- optional Fased Network bond assignment to a Vault wallet
- one offline reserve outside the runtime

The recommended security model is:

- self-hosted signer
- passkey approval
- split-key where needed
- Vault custody unlock until manual lock, or short timed unlock when preferred
- Agent automation stop/resume for emergency pause
- deliberate sweeps

## 1. Onboarding and first setup

The normal public flow is:

1. create or import the wallet during onboarding or `fased wallet setup`
2. configure chain RPC
3. let the runtime register the wallet
4. verify signer health
5. assign Agent, mining, Vault, and optional Fased Network bond usage intentionally

Good rule:

- never let the import step become your only backup of the key material

## 2. Self-hosted signer model

The public self-hosted path is:

- provider id `local-socket-signer`
- native signer `fased-signerd`
- explicit RPC for the relevant chain

Useful checks:

```bash
fased wallet signer doctor --json
fased wallet status --json
```

For the full file layout and signer boundary, see [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted).

## 3. Funding and working balances

Runtime wallets should be sized as working wallets.

Good operating posture:

- Agent wallets hold everyday working capital for approved agent actions
- mining wallet holds enough SOL for fees, reserve, capital staging, and short-lived Satcoin
- Vault wallet stays manual-first and can hold Satcoin you intentionally want to lock or prove with
- offline reserve stays outside the runtime

Practical rule:

- every Solana working wallet needs SOL for fees
- every runtime wallet should stay intentionally small

## 4. Role split today

The operator model in the product is:

- `agent`
  user-facing Agent wallets. Multiple wallets may carry this role; one can be primary for fallback.
- `mining`
  Satcoin capital, claim, and sweep path
- `vault`
  manual-first hot or warm reserve use; Fased Network bond can be assigned to a Vault wallet

Important detail:

- wallet purpose is stored as Agent, Mining, or Vault
- new policy, custody, and signer status records use `agent`, `vault`, or `mining`
- risky chat and skill actions use explicit `@wallet:<walletId>` handles or
  structured `walletId`; display names are labels only
- Agent wallets are the automation path; Vault wallets are manual-only and use reviewed Wallets page approval
- Mining wallets should not be repurposed; create a new Agent or Vault wallet when the purpose changes

## 5. Wallet policy profiles

The runtime supports policy profiles such as:

```bash
fased wallet policy profile manual-owner
fased wallet policy profile autonomous-strict
fased wallet policy profile autonomous-moderate
```

Practical reading:

- `manual-owner`
  recommended starting point for human-reviewed operation
- `autonomous-strict`
  narrow automation posture with tighter limits
- `autonomous-moderate`
  broader automation posture with deliberate guardrails

Remember:

- these are wallet send guardrails
- they do not replace mining reserve, bond rules, or custody state

## 6. Wallet actions

Agent wallets are the wallets for reviewed chat, skill, plugin, scheduled, and
optional advanced wallet actions. Mining wallets are rejected for generic sends,
advanced wallet actions, and recurring wallet-action flows because they use the
SAT mining and SAT sweep policy. Vault wallets are rejected for chat, skill,
plugin, and scheduled task sends because they are manual-only reviewed Wallets
page sources.

Supported Solana action classes, when enabled and allowed by policy:

- native SOL and SPL sends through reviewed wallet requests
- route quotes and optional route actions through the Fased wallet wrapper
- token route actions only when policy allows that asset and route
- disabled recurring plans that the operator can review before enabling
- saved recurring Agent native/SPL transfer policy shared by chat and Wallets UI
- optional trigger-order create, history, and cancel/reclaim when configured

Policy rules:

- use explicit handles such as `@wallet:agent`
- display names are hints only
- Caps defaults Off on fresh wallets; turn it On when you want limit enforcement
- SOL and SPL token rows are separate when Caps is On
- route program allowlists can restrict inspected route adapters
- live trigger orders can deposit input funds into a third-party route vault until fill, expiry, or cancellation/reclaim

Enable live trigger orders only when you intend to use that optional advanced path:

```bash
fased wallet limit-orders --enable --jupiter-api-key <jupiter-api-key>
```

Do not paste route-action API keys into chat or channel messages.

## 7. Approval flow

The ordinary user send path is:

1. create a send request
2. review the pending request
3. approve it
4. complete passkey approval if enabled
5. let the runtime execute and log the send

The Wallets page is an approval surface. It shows the request before signing and
broadcast.

### Approval details and audit records

Fased simulates the policy decision before approval, records an approval diff on
the pending request, and writes an audit record. The approval review should
answer:

- source wallet role and handle
- destination address or local wallet handle
- chain and token/mint
- requested amount and fee estimate when the selected chain/provider exposes one
- trigger source: UI, chat, channel, task, skill, plugin, or mining runtime
- Agent id and session/task id when available
- skill id and Wallet > Skill Grant when the request came from a skill
- cap state: per-transaction cap, daily cap, and already-spent amount
- custody state: locked, unlocked, passkey required, or approval token required
- final policy result: allowed, pending manual approval, or rejected
- run/history id for audit visibility

This policy-simulation, approval-diff, and audit lane does not broaden wallet
authority. It makes the current authority easier to inspect before signing.
Final signing still goes through wallet policy, custody, and passkey approval
when enabled.

### Roadmap: policy presets

Wallet policy should stay editable, but normal operators should be able to
start from one-click presets in Wallets > Access. Preset meanings:

**Read-only**

Balance and status only.

**Manual only**

Wallets UI reviewed requests only.

**Small Agent spend**

Agent wallet can perform small approved work under low caps and narrow
destinations/routes.

**Mining only**

Mining wallet can perform SAT mining and sweep paths.

**Skill limited**

Reviewed wallet-capable skills can use only selected Agent wallets, actions,
and caps.

**Advanced wallet actions**

Agent wallet can use inspected route-action adapters with explicit caps and
route checks.

Presets compile down to the same role policy, caps, allowlists, approval mode,
and skill-grant checks that the runtime already enforces. They are not a second
policy system.

### Roadmap: secret proxy boundary

Fased supports SecretRef and focused Services/Skills setup. The runtime also has
a secret-proxy primitive for service/tool code: resolve a SecretRef inside a
bounded provider call, return only sanitized results, and fail if the call tries
to echo the raw secret back out.

This is a lower-level boundary. Keep secrets in Agent > Services, Agent >
Skills config, environment-backed SecretRefs, or Advanced Config only when no
friendly page exists. Keep provider API keys out of chat and skill instructions.

## 8. Passkey and split-key custody

Recommended order:

1. enable Wallet Control Passkey
2. enroll at least one passkey
3. keep Agent automation controlled by caps and use `Stop` when automation should pause
4. enable split-key on Vault wallets that should require custody unlock
5. keep Vault wallets locked when idle, or unlock until you manually lock them again

Passkey is the ceremony layer.
Split-key is the locked-wallet layer.
Agent `Stop` is an automation control, not a custody lock.

For the detailed walkthroughs, see:

- [Wallet Control Passkey](/plugins/crypto/wallet-control-passkey)
- [Autonomous wallet security](/plugins/crypto/wallet-autonomous-security)
- [Autonomous wallet sessions](/plugins/crypto/wallet-autonomous-sessions)

## 9. Sweep discipline

Sweeps are part of healthy wallet hygiene.

Good rules:

- keep Agent wallet near working-capital size
- keep mining wallet small except when staging capital or claims
- keep the bond Vault narrow to intentional bond-related Satcoin
- move excess value out on purpose

Mining adds a separate post-claim Satcoin sweep model:

- destination runtime wallet id or external Solana address
- `all` or `percentage`
- minimum threshold
- keep-after-sweep balance

Manual one-off transfers still belong in Wallet.
Recurring Agent-wallet SOL/SPL transfers use `wallet_action.schedule_send` to
create disabled Task templates and, when requested, save the same wallet-scoped
recurring transfer policy shown in Wallets UI. They still run through normal
Auto, enabled caps, custody, signer, and audit checks on every execution. Vault
wallets remain manual-only.
Automated Satcoin post-claim sweeps remain a Mining-specific policy.

## 9. Production checklist

Treat the wallet stack as ready for serious operation only when all of these are true:

1. signer health is healthy
2. RPC is healthy
3. the expected wallets appear in Wallet
4. addresses and balances resolve correctly
5. send approval works
6. passkey is enrolled if you plan to use secured flows
7. restart preserves wallet availability
8. Agent, mining, and bond separation is intentional
9. working balances are intentionally small
10. sweep discipline exists and is reviewed

## 10. Scope

This page describes the current operator contract.

Current scope:

- each economic role has its own wallet lane
- passkey is one layer in the wallet security model
- future plugin automation paths will be documented as they become public and
  stable

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet Control Passkey](/plugins/crypto/wallet-control-passkey)
- [Wallet selection contract](/plugins/crypto/wallet-selection-contract)
- [Self-hosted wallet VPS validation](/plugins/crypto/wallet-self-hosted-vps)
- [Mining](/plugins/crypto/mining-page)
- [Fased Network](/start/federation)
