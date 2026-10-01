---
summary: "One wallet model with explicit permissions and budgets."
title: "Wallet policies"
---

# Wallet policies

Create as many ordinary wallets as you need. Names such as Reserve or Trading are labels, not permanent wallet types. A wallet can serve WEN and another enabled trading module when its separate policies permit those operations.

New wallets are read-only. Enabling an agent or installing a module does not grant spending authority. Assign the exact wallet, chain, programs, assets, permitted actions, positive amount and fee caps, and approval mode before enabling financial work.

Use reviewed owner approval for individual transactions or explicitly bounded delegation for unattended tasks. Missing or stale policy, an unrecognized operation, or a request outside a cap fails closed. The signer independently validates the transaction and maintains replay protection and durable accounting.

The browser account passkey protects access to the application. Signer approval is a separate authority boundary. Restarting does not reset budgets or permit a second submission of an unresolved operation.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
