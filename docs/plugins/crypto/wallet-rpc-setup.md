---
summary: "Set one Solana RPC per wallet and understand the execution, read, and verification boundaries."
read_when:
  - Preparing an Agent, Mining, or Vault wallet
  - Fixing signer RPC readiness
title: "Solana RPC Setup"
sidebarTitle: "RPC setup"
---

# Solana RPC setup

Normal onboarding is deliberately simple:

1. Select Agent, Mining, or Vault.
2. Enter one RPC for that wallet.

There is no Solana-network question and no second-RPC question. The Go signer
reads the live genesis hash, pins the wallet to that cluster, and selects the
matching official Solana endpoint as a verification-only witness.

## What uses the RPC

Fased keeps three responsibilities separate:

- **Signer execution:** balance checks, transaction construction, simulation,
  broadcast, and reconciliation.
- **Gateway read/preparation:** dashboard inventory, token/SAT status,
  federation and bond reads, and provider/hardware preparation.
- **Official verification witness:** sensitive ALT account bytes and slot
  agreement only. It never constructs, simulates, broadcasts, reconciles, or
  supplies an execution blockhash.

The normal wizard initially uses the entered endpoint for the first two planes.
That gives Local and Hosting the same one-entry experience. Advanced operators
may later give Gateway a separate read-only credential.

## Create or update

Create from the terminal:

```bash
fased wallet setup --mode local-signer-create \
  --wallet-id agent --wallet-name "Agent" --role agent \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

After installation, open **Control UI → Wallets → Settings**, select the RPC
edit icon, enter the replacement, and choose **Save**. The terminal **Manage
wallet** flow provides the same operation.

The signer accepts the replacement only when it:

- is a canonical HTTPS URL, except loopback Local development;
- avoids credentials in URL userinfo, fragments, private/metadata/link-local,
  multicast, and unspecified targets;
- stays on the wallet's current Solana network; and
- produces the exact next signer network version.

The UI receives readiness, version, and keyed hash—not the stored signer URL.

## Official witness and ALT safety

For a normal public Solana cluster, the signer derives the official public
witness automatically. The witness is allowed only to verify ALT account bytes
and slot agreement against the primary. A mismatch disables that sensitive
operation.

If the primary itself is the official public endpoint, sensitive ALT work stays
unavailable until an independent origin is configured. Custom clusters and
Localnet also need an explicit independent origin because no official witness
can be derived safely.

## Advanced execution fallback

An advanced operator may configure a second full execution RPC through the
native signer admin interface. It must have a distinct origin and live
same-genesis agreement. This fallback can participate in signer execution; the
automatic official witness cannot.

Do not add the fallback to ordinary onboarding or treat Gateway environment
fallbacks as signer authority.

## Validate before funding

```bash
fased wallet signer doctor --json
fased wallet status --json
fased mining readiness --wallet mining
```

Fund only after key, RPC, network, signer policy, and backup readiness are
clear. An RPC timeout after broadcast must reconcile the exact stored signature;
never construct a changed replacement automatically.

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Self-hosted signer](/plugins/crypto/wallet-self-hosted)
- [Mining troubleshooting](/plugins/crypto/mining-troubleshooting)
