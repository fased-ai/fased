---
summary: "Prepare, approve, execute and recover exact operations."
title: "Wallet operations and recovery"
---

# Wallet operations and recovery

Start with a read-only wallet. Enable only the operations needed for the task and keep working balances and budgets deliberately limited.

Prepare an exact operation against fresh network and accounting state. Review amounts, allowed programs and assets, destinations, simulation, fee limits and expiry. Obtain the required owner approval or verify a matching bounded delegation. The isolated signer validates these constraints independently before signing.

Persist the operation identity and result. Submission is not final confirmation. Reconcile chain status and balances, including after restart. An unknown result blocks duplicate execution until the original request is resolved.

Backup and key export are explicit native owner operations. No private key is automatically displayed after browser creation. Never place keys in chat, logs or task input.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
