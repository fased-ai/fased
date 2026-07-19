---
summary: "Create, import, recover, inspect, and manage Fased wallets from the CLI."
read_when:
  - You want a native Agent, Mining, or Vault wallet
  - You need one-RPC setup, recovery, status, or signer diagnostics
title: "wallet"
---

# `fased wallet`

The wallet CLI and terminal onboarding use the same native Go-signer lifecycle.
The role is always explicit. Fased never silently selects Agent, never asks for
a Solana network, and normal setup asks for one primary RPC.

## Create a wallet

```bash
fased wallet setup --mode local-signer-create \
  --wallet-id agent --wallet-name "Agent" --role agent \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

Use `--role agent`, `--role mining`, or `--role vault`. Only one active Mining
wallet is allowed. The signer generates the key, pins the endpoint's live
genesis hash, derives the official verification-only witness, installs the
role-locked receive-only baseline, and returns the public address and readiness.

## Import an existing Solana keypair on Local

Keep the keypair in an owner-only file. Its contents go to the native signer by
file descriptor, never through an argument, environment variable, log, chat, or
browser request.

```bash
chmod 600 /absolute/path/to/solana-keypair.json
fased wallet setup --mode local-signer-import \
  --wallet-id mining --wallet-name "Mining" --role mining \
  --import-file /absolute/path/to/solana-keypair.json \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

Hosting keeps plaintext keys outside the `app`/Gateway account. From the VPS
provider root console, use the installed fixed-purpose helper:

```bash
chmod 600 /root/wallet.json
/usr/local/sbin/fased-signer-wallet-import \
  --wallet-id mining --locked-role mining < /root/wallet.json
```

Return to `app`, rerun onboarding, and choose **Create** with the same role and
wallet ID. The signer reuses only that exact existing deny-all wallet, then the
normal one-RPC step registers it. The app account has no sudo rule for import.

The Control UI can create Agent, Mining, and Vault wallets. Existing-key import
stays terminal-only until a separate signer-owned import ceremony is available.

## Encrypted recovery

Create an Argon2id plus authenticated-encryption recovery package:

```bash
fased wallet recovery export \
  --wallet-id agent \
  --output /absolute/new/agent-recovery.json
```

The Go signer reads and confirms the recovery password directly from the
terminal. Restore into a new role-locked wallet on Local:

```bash
fased wallet recovery import \
  --wallet-id agent-restored --wallet-name "Restored Agent" --role agent \
  --file /absolute/path/agent-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

On Hosting, recovery export/import remains a signer-owner operation from the VPS
provider console. This prevents a compromised Gateway from choosing a password,
capturing the recovery password, or exporting an existing wallet.

Advanced raw export is explicit and reduces custody protection:

```bash
fased wallet recovery export-raw \
  --wallet-id agent \
  --output /absolute/new/agent-keypair.json \
  --acknowledge-custody-reduction
```

Raw export is Local signer-owner only. The signer requires the exact wallet and
public address, writes a new `0600` file, and audits the operation without
recording key material.

## Status and RPC

```bash
fased wallet status --json
fased wallet signer doctor --json
```

The Control UI and terminal **Manage wallet** flow can replace a native wallet's
one primary RPC. The signer verifies the new endpoint against the wallet's
pinned genesis before accepting the next network version. Advanced operators
can configure a distinct second full execution origin with the native signer
admin command; it is not a normal onboarding question.

## Roles, policy, and passkeys

- **Agent** is a bounded hot-wallet role for approved agent automation.
- **Mining** is the singleton SAT-only automation role.
- **Vault** is manual-only.
- New native wallets start receive-only. Spending requires an exact reviewed
  signer policy.
- The optional **Control UI account passkey** protects the web account. It is
  not Agent or Mining wallet readiness.
- A Vault's Security panel keeps optional signer-owned approval guidance
  separate. Enrollment remains a native signer-owner ceremony; on Hosting use
  `/usr/local/sbin/fased-signer-enroll` from the provider root console.

Browser Wallets is the normal post-install management surface for inventory,
addresses, authenticated no-store Receive/QR, one-RPC changes, readiness, Primary Agent selection,
Mining attachment, policy status, and role-appropriate sends. It never accepts
a private key or recovery password.

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Solana RPC setup](/plugins/crypto/wallet-rpc-setup)
- [Self-hosted signer](/plugins/crypto/wallet-self-hosted)
