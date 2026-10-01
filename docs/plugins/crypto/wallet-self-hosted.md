---
summary: "Native signer custody for Local and Hosting."
title: "Self-hosted wallet signer"
---

# Self-hosted wallet signer

The native Go signer holds key material and exposes typed, policy-checked operations. The gateway receives public addresses and operation results, not a generic private-key signing primitive. Users download a verified prebuilt signer; installing Go is unnecessary.

Local and Hosting use the same ordinary-wallet workflow. Hosting adds managed service identities and protected application/operator sockets. Local still separates signer code from gateway code, but compromise of the owner OS account remains a custody risk.

Create or import an ordinary wallet, configure its verified RPC and start read-only. Financial execution requires exact signer policy and owner approval or bounded delegation. Application login alone is insufficient.

Use native owner commands for private-key import, backup or explicit export. WEN recovery concerns current operation journals only; the retired Satcoin miner is not part of the application.

See [Wallet CLI](/cli/wallet) and [Wallet policies](/plugins/crypto/wallet-roles-and-policies).
