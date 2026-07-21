---
summary: "How the native Go signer protects Agent, Mining, and Vault wallets on Local and Hosting."
read_when:
  - Creating or operating a native Fased wallet
  - Comparing Local and Hosting custody boundaries
title: "Self-hosted wallet signer"
sidebarTitle: "Self-hosted wallet"
---

# Self-hosted wallet signer

Fased's native wallet provider is `local-socket-signer`, backed by the Go
process `fased-signerd`. Keys are generated or imported inside that signer.
Gateway receives public addresses and typed results, never a generic signing
primitive or plaintext private key.

## Supported platforms

| Platform                     | Supported path                                                             |
| ---------------------------- | -------------------------------------------------------------------------- |
| Linux                        | Native Local signer                                                        |
| macOS Intel or Apple silicon | Native Local signer                                                        |
| Windows                      | WSL2 Ubuntu only; do not run Fased in PowerShell or native Windows Node.js |
| VPS Hosting                  | Root-managed Linux signer under the dedicated `fased-signer` account       |

The installer downloads the version-matched signer, verifies checksum and
artifact attestation, and installs it automatically. Users do not install Go.

## Local and Hosting user experience

Both flows are the same from the user's perspective:

1. Choose **Create** or **Import**.
2. Explicitly select **Agent**, **Mining**, or **Vault**.
3. Optionally enter a display name; Fased generates the wallet ID.
4. Enter one Solana RPC.
5. Receive the public address and one readiness result.

There is no default role, Solana-network prompt, second-RPC prompt, browser
passkey prompt, or manual root network command in ordinary onboarding.

The Control UI can create Agent, Mining, and Vault wallets after installation.
Only one active Mining wallet is allowed. Existing-key import remains in the
terminal so private material never enters Gateway JavaScript.

## Local and Hosting security boundaries

### Local Linux, macOS, and WSL2

Gateway and signer run as the signed-in OS user. Go still isolates key handling
from normal Gateway code, but a compromise of that OS account can reach the
same user's processes and files. Use deliberately limited balances.

### VPS Hosting

Hosting is a stronger boundary. The dedicated signer account owns encrypted
state, master key, audit log, and `/run/fased-signerd/control.sock`. Gateway can
reach only `/run/fased-signerd/app.sock`.

The Gateway app socket permits typed application operations but no owner
lifecycle authority. The human `app` operator uses a separate peer-credential-
checked `/run/fased-signerd/operator.sock` for create, import, recovery, raw
export, RPC changes, explicit legacy baseline activation, and retirement. The
Gateway account cannot connect to that socket or access signer state.

## Roles

- **Agent:** bounded hot-wallet automation under exact policy limits.
- **Mining:** singleton SAT-only automation wallet.
- **Vault:** manual-only reserve role.

Roles are permanent inside the signer. A role change means creating a successor
wallet and using the guarded Archive/Replace flow. Mining retirement writes a
signer tombstone before registration and attachments move; normal setup cannot
reuse the retired wallet ID.

## One-RPC model

The entered endpoint becomes the wallet's execution RPC and initial
Gateway read endpoint. The signer pins its live genesis hash and derives the
matching official Solana endpoint as a verification-only witness.

The witness may compare sensitive ALT account bytes and slots. It never
constructs, simulates, broadcasts, reconciles, or supplies execution balances
or blockhashes. An RPC that is itself the official endpoint cannot provide
independent ALT verification; custom clusters and Localnet also require an
explicit independent origin.

Advanced users may configure a distinct second full execution RPC. This is not
a normal onboarding field. See [Solana RPC setup](/plugins/crypto/wallet-rpc-setup).

## Policy and authorization

Every new wallet starts with signer-owned role baseline v1. Agent and Vault are
ready for reviewed owner transfers under exact destinations and positive caps;
Mining is ready only for release-bound typed SAT actions and reviewed owner
movement. Broader automation still requires exact signer policy and runtime
grants.

Agent and Mining automation do not require a passkey for operations already
inside their narrow typed policies. Manual work outside that policy is rejected
or uses a separately enabled owner-review lane.

The optional **Control UI account passkey** belongs under **Account Security**.
It protects the web account and does not affect Agent or Mining readiness. An
optional signer-owned **Vault approval device** is reported separately in that
Vault's Security panel, but enrollment remains a native operator ceremony;
ordinary Gateway JavaScript cannot enroll signer credentials.

## Create and import

Create:

```bash
fased wallet create \
  --wallet-id agent --wallet-name "Agent" --role agent \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

Import an owner-only Solana CLI keypair:

```bash
chmod 600 /absolute/path/to/solana-keypair.json
fased wallet import \
  --wallet-id mining --wallet-name "Mining" --role mining \
  --file /absolute/path/to/solana-keypair.json \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

The keypair is passed by file descriptor. Do not paste private keys, seed
phrases, recovery passwords, or RPC credentials into chat, browser forms,
arguments, environment variables, or logs.

On Hosting, run the same command from the `app` operator shell. The restricted
operator socket performs the complete role-baseline and one-RPC lifecycle. The
`fased-gateway` account cannot run it.

## Recovery and raw export

The default backup is an Argon2id plus authenticated-encryption package:

```bash
fased wallet recovery export \
  --wallet-id agent --output /absolute/new/agent-recovery.json
```

The signer reads the password directly from the terminal and writes a new
owner-only file. Local restore creates a new role-locked wallet:

```bash
fased wallet recovery import \
  --wallet-id agent-restored --wallet-name "Restored Agent" --role agent \
  --file /absolute/path/agent-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

Hosting export/restore uses the same operator CLI while remaining unavailable
to the Gateway service, so a compromised Gateway cannot choose or capture the
password or export existing custody.

Advanced Local or Hosting operators can explicitly export a raw key with
`fased wallet recovery export-raw --acknowledge-custody-reduction`. This writes
a new `0600` file and reduces the Go-signer custody protection.

## Readiness before funding

```bash
fased wallet signer doctor --json
fased wallet status --json
fased mining readiness --wallet mining
```

Verify:

- exact role and public address;
- signer key and one-RPC network readiness;
- acknowledged role policy version/hash;
- recovery backup for funded wallets; and
- Mining singleton or explicit Default Agent attachment as appropriate.

The signer stores durable request IDs, transaction digests, cap reservations,
daily totals, broadcast state, and reconciliation state. Ambiguous broadcast is
reconciled using the exact stored signature; Fased does not build a changed
replacement automatically.

Related:

- [Wallets](/plugins/crypto/wallet-page)
- [Wallet CLI](/cli/wallet)
- [Solana RPC setup](/plugins/crypto/wallet-rpc-setup)
- [Wallet security](/plugins/crypto/wallet-autonomous-security)
