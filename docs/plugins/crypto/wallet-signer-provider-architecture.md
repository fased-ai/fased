---
summary: "Independent custody, policy validation and durable operation recovery."
title: "Wallet signer architecture"
---

# Wallet signer architecture

The gateway prepares typed requests; the native signer independently validates wallet identity, network, programs, assets, destinations, amount and fee limits, replay state and approval authority. An agent cannot replace this validation with its own decision.

All user wallets share one model. Labels and agent assignments describe purpose; policies define authority. WEN and an enabled trading module may use a wallet only for explicitly permitted operations. New wallets are read-only.

Separate application and owner lifecycle interfaces prevent ordinary gateway access from expanding policy or exporting keys. Private material remains in native custody. Account authentication and signer transaction approval serve different purposes.

Persist requests and reconcile results after disconnection or restart. Do not re-execute an unknown submission. The old Satcoin cycle, Federation Bond and on-chain Agent-capital implementations have been retired; current WEN protocol operations retain their own typed validation.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
