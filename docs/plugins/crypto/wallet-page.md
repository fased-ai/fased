---
summary: "Create and manage ordinary wallets and permissions."
title: "Wallets"
---

# Wallets

Wallets is the same user-facing workflow in Local and Hosting. Create a wallet with an optional name and a Solana RPC, copy its address, view available balances, and manage permissions. There is no Agent, Mining or Vault type to select.

Private keys are handled by the native signer. Browser creation returns public identity and readiness; private-key import and recovery use the documented native CLI path, not a browser text field.

Choose the exact wallet when preparing a WEN action. Review its amounts, destination or pool, simulation, fees and expiry. The signer accepts only a request covered by the wallet policy and required owner approval or bounded delegation. A displayed balance is not permission to spend.

If submission status is unknown, recover the existing request first. Do not create a replacement transaction until reconciliation establishes its outcome.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
