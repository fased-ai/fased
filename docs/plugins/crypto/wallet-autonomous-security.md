---
summary: "Narrow policies, durable budgets and recovery for unattended wallet work."
title: "Autonomous wallet security"
---

# Autonomous wallet security

Autonomy is explicit bounded delegation, not access to an unlocked private key. All wallets use one model. A reserve label does not impose a security boundary; the applied policy does.

Specify exact wallet identity, network, operations, programs, assets, destinations, positive transaction and cumulative budgets, fee limits, expiry and permitted agents. Keep the funded balance within the loss you intentionally accept. Missing, stale or conflicting policy fails closed.

The signer validates transaction semantics independently, enforces budgets and replay protection, and persists operation state. Installing a module, skill or task does not grant authority. Network messages and account login cannot expand a wallet's policy.

Stopping an agent prevents new requests but is not a custody lock. Revoke delegation or tighten policy to stop signing; reconcile any already-submitted operation. Following a timeout or restart, recover the original journal without signing a replacement while the outcome remains unknown.

See [Wallet policies](/plugins/crypto/wallet-roles-and-policies) and [Wallet recovery](/plugins/crypto/wallet-production-flow).
