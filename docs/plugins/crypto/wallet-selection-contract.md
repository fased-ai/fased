---
summary: "Explicit wallet selection for WEN and agent tasks."
title: "Wallet selection"
---

# Wallet selection

Use an explicit wallet ID or an approved agent assignment. Wallet display names are not unique authority identifiers. A default selection is a convenience only and cannot override signer policy.

WEN and trading may use the same wallet or different wallets. Each operation must match the selected wallet, pinned network, permitted programs and assets, action, amount, fees and approval mode. Do not infer spending permission from a wallet name, agent conversation or Network message.

When selection is missing or ambiguous, ask for the wallet or reject the request. Recovery always uses the original operation and wallet identity; changing a default cannot redirect an outstanding transaction.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
