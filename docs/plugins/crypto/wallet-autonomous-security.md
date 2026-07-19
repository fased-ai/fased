---
summary: "Safe unattended Agent and Mining operation with typed signer policy, durable caps, idempotency, and emergency controls."
read_when:
  - Enabling Agent, skill, task, Jupiter, Trigger, or mining automation
  - Deciding how much value an unattended wallet should hold
title: "Autonomous wallet security"
sidebarTitle: "Autonomous security"
---

# Autonomous wallet security

Autonomy is a narrow policy grant, not an unlocked private key.

Fased supports unattended work only through typed operations whose exact
programs, assets, destinations, amounts, and account semantics can be validated
by the signer.

## Which roles can be autonomous

- **Agent:** typed SOL/SPL transfers and reviewed semantic wallet actions when
  every required policy and skill-grant dimension is explicit.
- **Mining:** generated SAT protocol operations plus configured SOL fee/capital
  and reviewed SAT movement.
- **Vault:** never autonomous. Vault execution is manual reviewed work.

Do not enable generic `directSigning` to make a Vault flow work. Use signer
WebAuthn, a hardware-backed Wallet Standard account, or a strong Turnkey policy.

## Required Agent policy

An unattended Agent policy needs all of:

- exact wallet id and `agent` role;
- typed operation names;
- exact Solana program ids;
- explicit SOL/SPL assets and mints;
- explicit destinations;
- positive per-transaction cap;
- positive daily cap.

Missing policy, empty allowlists, zero/absent caps, stale policy version, or a
hash the signer did not acknowledge means deny.

Keep the Agent balance within the amount you intentionally accept as exposed by
that host, policy, and workflow. Caps reduce loss; they do not make a large hot
wallet safe.

## Skill and task authorization

A skill install or task schedule does not grant wallet access. The skill's
Agent-wallet grant must explicitly name actions, wallet ids, chain, trusted
registry (or `local` source), input/output mints, amount/slippage caps, and
autonomous/scheduled permission.

The signer policy may be narrower and is always final. Skills never receive
private keys, raw signer access, provider master credentials, or the native
control socket.

## Jupiter and Trigger operations

Jupiter swaps and Trigger order create/deposit/cancel/withdraw run through
semantic validators. The signer checks the decoded programs, mints,
destinations, PDAs, signer/writable flags, amounts, and expected transaction
binding.

Fased durably stores:

- stable intent and external authorization ids;
- endpoint/API-key/RPC binding hashes;
- prepared and signed artifacts;
- deposit/craft/create/cancel/withdraw phase;
- broadcast signature and final/unknown state.

After an ambiguous provider or RPC result, Fased does not fetch, sign, or submit
a replacement. Reconcile the exact existing request first.

## Mining autonomy

Mining uses generated SAT codecs shared by TypeScript and Go. The canonical
schema includes discriminator, payload length, program family, account flags,
and variable-account layout; CI and release checks reject generated drift.
The signer additionally validates action-specific PDAs, programs, mints,
destinations, amounts, and context.

Mining can receive SAT and needs SOL for fees/capital. That does not authorize
unrelated SPL tokens, arbitrary transfers, serialized trades, or raw
instructions.

## Durable accounting

The native signer reserves allowance atomically before signing and persists
daily totals across restart. Concurrent duplicates cannot both consume the same
remaining cap.

States are `reserved`, `broadcast`, `confirmed`, `failed`, and `unknown`.
`broadcast` and `unknown` count against the cap. Request id and immutable
transaction digest prevent a caller from reusing an approval for changed
parameters.

## Stop and recovery

Agent **Stop** and Mining **Stop** prevent new automation at the Gateway layer.
They do not erase keys, reset signer caps, cancel an already broadcast
transaction, or turn a hot wallet into offline custody.

When stopping automation:

1. stop the Agent/task/miner source;
2. inspect signer request and reconciliation state;
3. confirm no `reserved`, `broadcast`, or `unknown` request is unresolved;
4. tighten signer policy if authority should be removed;
5. sweep excess working value through a reviewed typed transfer;
6. review Gateway and signer audit logs.

## Local versus Hosting

Local Linux/macOS/WSL2 runs Gateway and signer as one OS user. Use it for
development and low-value working wallets; same-user compromise is outside its
hard boundary.

Hosting runs the root-managed signer as `fased-signer`, gives Gateway only the
typed application socket, and gives it no sudo or control-socket access. A
compromised Gateway can still request whatever the signer policy allows, which
is why exact allowlists, caps, WebAuthn for manual work, and low working
balances remain necessary.

## Checklist

- [ ] Role is Agent or Mining, never Vault.
- [ ] Wallet id/address/policy version/hash are verified.
- [ ] Every operation/program/asset/destination is explicit.
- [ ] Positive per-transaction and daily caps match a small working balance.
- [ ] Skill source/actions/mints/caps/autonomy are explicitly granted.
- [ ] Signer-owned RPC is ready.
- [ ] Duplicate/concurrent requests are tested.
- [ ] Ambiguous broadcast recovery is tested without retry.
- [ ] Cold restart preserves caps and pending state.
- [ ] Stop, tighten-policy, sweep, backup, and audit procedures are known.

## Related docs

- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Autonomous wallet sessions](/plugins/crypto/wallet-autonomous-sessions)
- [Wallet passkeys](/plugins/crypto/wallet-control-passkey)
- [Mining](/plugins/crypto/mining-page)
