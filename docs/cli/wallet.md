---
summary: "Create, import, recover, route, inspect, and retire signer-owned wallets."
read_when:
  - You want an Agent, Mining, or Vault wallet
  - You need RPC, recovery, routing, retirement, or signer status commands
title: "wallet"
---

# `fased wallet`

Local and Hosting use the same public wallet commands. Hosting runs them as the
`app` operator through a restricted signer socket; the Gateway cannot use that
lifecycle authority.

## Create

```bash
fased wallet create \
  --wallet-id agent --wallet-name "Agent" --role agent \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

Choose `agent`, `mining`, or `vault`. The signer creates the key, locks the
role, activates signer-owned baseline v1, verifies one primary RPC against its
live genesis hash, and returns authoritative readiness. Retry the same wallet
ID with `--force` only to resume the same role; it never replaces or changes an
existing wallet silently.

Creating an Agent wallet does not automatically make it the Default Agent
wallet.

## Import

Keep a Solana keypair in a new owner-only regular file:

```bash
chmod 600 /absolute/path/to/solana-keypair.json
fased wallet import \
  --wallet-id mining --wallet-name "Mining" --role mining \
  --file /absolute/path/to/solana-keypair.json \
  --rpc-url https://your-solana-rpc.example --non-interactive
```

The file contents go directly to the native signer, not through argv,
environment variables, chat, logs, or the ordinary browser API. Hosting uses
this same command from the `app` operator shell. The key file must be owned by
that terminal user, mode `0600`, regular, non-symlink, and single-link.

## Recover

Export an encrypted recovery package:

```bash
fased wallet recovery export \
  --wallet-id agent \
  --output /absolute/new/agent-recovery.json
```

Restore it to a new wallet ID with the same intended role:

```bash
fased wallet recovery import \
  --wallet-id agent-restored --wallet-name "Restored Agent" --role agent \
  --file /absolute/path/agent-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

Passwords are read by the signer from the native terminal. They never belong
in a command argument, environment variable, browser request, or chat.

<Accordion title="Advanced raw export">
  Raw export reduces custody protection and requires an explicit acknowledgement:

```bash
fased wallet recovery export-raw \
  --wallet-id agent \
  --output /absolute/new/agent-keypair.json \
  --acknowledge-custody-reduction
```

The signer writes a new `0600` file and audits the exact wallet/address
operation without logging key material.
</Accordion>

## Set one RPC

```bash
fased wallet rpc set \
  --wallet-id agent \
  --rpc-url https://your-solana-rpc.example
```

The signer verifies the endpoint against the wallet's pinned genesis before it
commits the next network version. Normal setup uses one execution RPC; the
official public witness is verification-only, never an execution fallback.

## Default Agent and routing

Make an existing Agent wallet the optional final fallback:

```bash
fased wallet role set agent agent --primary
```

Risky Agent actions resolve in this order:

1. explicit `@wallet:<walletId>` or structured `walletId`;
2. one exact wallet override in the calling skill's approved grant;
3. the calling Agent's explicit assignment; and
4. the optional Default Agent wallet.

There is no automatic fallback mutation during create/import. Mining never
enters generic skill routing; Vault remains reviewed/manual.

## Migrate a legacy deny-all wallet

New wallets receive role baseline v1 during create/import/recovery. An existing
legacy deny-all wallet is never expanded silently. After reviewing its immutable
role, activate once:

```bash
fased wallet policy activate-role-baseline \
  --wallet-id agent --role agent --confirm
```

The command fails if the wallet is already active, has another role, or changed
concurrently.

## Retire and replace Mining

Stop Mining and replace the active wallet transactionally:

```bash
fased wallet retire \
  --wallet-id mining \
  --successor-wallet-id mining-2 \
  --successor-wallet-name "Mining 2" \
  --recovery-file /absolute/new/mining-recovery.json \
  --rpc-url https://your-solana-rpc.example
```

The old wallet must have no live work or recoverable balance. The signer writes
an irreversible retirement tombstone before runtime assignments move, retains
encrypted recovery material, and creates a distinct role-ready successor. A
retry resumes from signed signer evidence; it does not reuse the retired ID.

Permanent key erasure is a separate advanced destructive action.

## Inspect

```bash
fased wallet status --json
fased wallet signer doctor --json
```

The status includes exact signer policy/network versions and hashes, role
baseline version, public address, registry attachment, and readiness.

## Related

- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Wallet selection](/plugins/crypto/wallet-selection-contract)
- [Mining](/plugins/crypto/mining-page)
- [Recovery and custody](/plugins/crypto/wallet-production-flow)
