---
summary: "Validate the self-hosted wallet signer path on a VPS without sending transactions."
read_when:
  - You are checking self-hosted wallet readiness on a VPS
  - You want to verify signer health, RPC wiring, and wallet state without a live send
title: "Self-hosted wallet VPS validation"
sidebarTitle: "Wallet VPS validation"
---

# Self-hosted wallet VPS validation

This guide validates the self-hosted wallet path on a VPS without sending live transactions.

It is written for the public Fased wallet model:

- self-hosted wallets
- `local-socket-signer`
- explicit RPC wiring
- runtime health before wallet-bearing automation

## Prerequisites

- Fased is already installed on the VPS
- self-hosted wallet material already created or imported through onboarding or CLI
- chain RPC configured for the wallet role you are validating

Fased installs the version-matched native signer during Hosting bootstrap and
verifies both its checksum and GitHub release attestation. Hosting runs it as an
independent root-managed systemd service under `fased-signer`; the Gateway gets
only the group-authorized app socket and has neither the control socket nor
sudo. QuickStart therefore probes the existing service and never installs,
starts, or brokers a second signer.

A healthy signer service is only the first readiness layer. A new wallet is
created inside Go with a locked deny-all policy. It becomes send-ready only
after the owner/policy enrollment and per-wallet RPC configuration have been
acknowledged by the signer. Import is an explicit signer-admin operation; do
not paste a private key into the Gateway or dashboard.

For Solana RPC setup, use [Solana RPC setup](/plugins/crypto/wallet-rpc-setup).

## Canonical runtime expectation

For unattended self-hosted operation, the wallet path should look like:

- wallet entry exists in the runtime registry
- `local-socket-signer` is healthy
- RPC is configured for the relevant chain
- wallet appears in the Wallets page and status outputs

## Validation flow

### 1. Check signer health

```bash
fased wallet signer doctor --json
```

### 2. Check wallet visibility

Open the Wallets page or inspect runtime status to confirm:

- wallet id
- address
- visible balances
- signer-ready state

### 3. Confirm chain RPC wiring

The wallet path is ready for unattended use only after chain RPC is set and
responsive.

Use the runtime and wallet status surfaces to confirm:

- Solana readiness
- the configured RPC is responsive

### 4. Confirm Satcoin-mining-specific expectations when relevant

If the wallet is intended for Satcoin:

- it should be a dedicated wallet role
- it should be the singleton `@wallet:mining` runtime wallet
- mining readiness should pass before any capital deposit or start

```bash
fased mining readiness --wallet mining
```

## Operational rule

Wallet readiness means more than a file on disk.

Treat the wallet as ready only when all of these are true:

- signer is healthy
- wallet is visible in runtime state
- RPC is valid
- sends and policy checks are ready
- mining readiness passes if this wallet is meant for Satcoin

## Related docs

- [Wallet](/plugins/crypto/wallet-page)
- [Solana RPC setup](/plugins/crypto/wallet-rpc-setup)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Wallet selection contract](/plugins/crypto/wallet-selection-contract)
- [Mining](/plugins/crypto/mining-page)
