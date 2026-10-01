---
summary: "Application authentication and separate exact-operation approval."
title: "Account and signer approval"
---

# Account and signer approval

The optional Control UI account passkey protects application sign-in. It is separate from Solana wallet custody, signer policy and approval of a transaction. Signing in does not enable financial actions.

An owner-reviewed native operation uses its configured signer approval flow and exact request. An authenticator credential, when configured, is enrolled through the owner ceremony, not by an agent. Current ordinary wallets are not divided into Agent, Mining or Vault types.

Unattended execution requires explicit bounded delegation. A request outside that delegation is rejected or needs a new owner-approved review; it cannot inherit authority from an existing browser session.

See [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
