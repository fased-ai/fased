---
summary: "Bounded delegation for unattended wallet operations."
title: "Automatic wallet permissions"
---

# Automatic wallet permissions

Ordinary wallets start read-only. To allow unattended work, explicitly delegate the required actions to the assigned agent with pinned network, programs, assets and destinations, positive spending and fee limits, expiry, and concurrency limits.

Delegation is separate from account login, module installation and Network membership. Requests outside the approved policy are rejected. The signer independently validates the exact transaction and records replay and budget state.

For manual work, prepare a fresh exact review and obtain its required owner approval. Do not treat a long-running chat session as transaction authorization. After interruption, reconcile the original operation before attempting another.

See [Wallet policies](/plugins/crypto/wallet-roles-and-policies) and [Wallet recovery](/plugins/crypto/wallet-production-flow).
