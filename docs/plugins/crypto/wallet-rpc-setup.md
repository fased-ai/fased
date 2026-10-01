---
summary: "Configure the verified Solana RPC used by a wallet."
title: "Wallet RPC"
---

# Wallet RPC

Create an ordinary wallet and supply one Solana RPC. The signer verifies its network identity. WEN reads and the signer need Solana node access even when an external browser wallet handles the signature; a keeper is a separate application role.

Keep WEN and the selected wallet on the same network. Devnet balances and synthetic prices are test inputs, not production assets or executable mainnet economics. Changing an endpoint must preserve the pinned network identity.

A verified endpoint does not grant financial permissions. Configure the exact wallet policy separately. Do not put RPC credentials in public screenshots, logs or documentation.

See [Wallets](/plugins/crypto/wallet-page) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
