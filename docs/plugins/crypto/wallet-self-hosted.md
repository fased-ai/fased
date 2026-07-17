---
summary: "Native self-hosted signer setup, Local and Hosting boundaries, key lifecycle, policy, WebAuthn, RPC, files, and recovery."
read_when:
  - Creating or operating a native Fased wallet
  - Understanding what Go, the Gateway, and the host administrator can access
title: "Self-hosted wallet signer"
sidebarTitle: "Self-hosted wallet"
---

# Self-hosted wallet signer

The supported self-hosted wallet provider is `local-socket-signer`, backed by
the native Go process `fased-signerd`.

The native signer owns key lifecycle, policy, WebAuthn, RPC configuration,
durable caps, signing, broadcast state, and reconciliation. The Gateway asks
for typed operations and receives public state or structured results. It does
not receive a generic signing primitive or plaintext private key.

## Platform support

| Platform                                   | Supported path                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Linux desktop/server                       | Native Local signer                                                        |
| macOS `amd64` or `arm64`                   | Native Local signer                                                        |
| Windows 11 or Windows 10 2004/build 19041+ | Install and run Fased inside WSL2 Ubuntu; use the Linux signer asset       |
| VPS Hosting                                | Root-managed Linux signer service under a dedicated `fased-signer` account |
| Local Docker                               | Separate non-root signer container; Local only, not VPS Hosting            |

Native Windows PowerShell, Command Prompt, Git Bash, and Windows Node.js are not
supported because the signer protocol uses Unix sockets. Follow [Windows
(WSL2)](/platforms/windows) and run every Fased command inside Ubuntu.

Normal users do not install Go. The installer downloads the signer asset for
the exact Fased version, verifies its SHA-256 checksum and GitHub artifact
attestation, then installs it automatically. Building from source is a
developer-only fallback.

## Local and Hosting are different boundaries

### Local Linux, macOS, and WSL2

Gateway and signer run as the signed-in OS user. Go still owns creation,
import, encrypted key state, and signing, so ordinary Gateway code never sees
plaintext key material. However, a process that compromises the same OS user
may be able to inspect that user's files or processes.

Use Local for development and intentionally limited working balances. It is
not a hard custody boundary against a compromised Gateway process or user
account.

### VPS Hosting

Hosting creates a locked `fased-signer` OS account and installs a root-managed,
hardened systemd service. The signer owns:

- `/var/lib/fased-signerd/state.db`
- `/var/lib/fased-signerd/master.key`
- `/var/lib/fased-signerd/audit.jsonl`
- `/run/fased-signerd/control.sock` (`0600`, signer only)

The Gateway account receives only `/run/fased-signerd/app.sock`, authorized by
its group and limited to protocol-v2 application operations. It has no signer
sudo rule, cannot connect to the control socket, and cannot install or execute
code as `fased-signer`.

Root updates the fixed native binary only after exact version, checksum, and
GitHub attestation verification. The updater gates requests, snapshots
signer-owned state, restarts the service, verifies health, and rolls back or
quarantines an unsafe update.

## First wallet setup

On a fresh Local or Hosting install:

1. Fased verifies and starts the version-matched native signer.
2. Wallet creation runs inside Go and returns only the public address.
3. The wallet receives its permanent `agent`, `mining`, or `vault` role.
4. It starts with an explicit deny-all policy.
5. The Gateway registers the operator-facing id, canonical signer id, and public
   address.
6. The operator configures signer execution RPC and Gateway read RPC.
7. The operator copies/reviews the role template and activates it with the
   owner-policy helper.
8. Manual native Agent, Mining, and Vault reviews require separate signer
   WebAuthn enrollment.
9. The operator verifies policy/network hashes and only then funds a deliberately
   small balance.

If setup is interrupted, rerun the wallet setup. Creation and migration are
idempotent: Fased queries signer state and refuses wallet-id/address collisions
instead of creating a replacement key.

The Gateway can tighten an acknowledged policy, but it cannot silently expand
authority. Initial expansion and later loosening require the signer admin/owner
workflow.

## Create versus import

Creating a new wallet is the normal first-wallet path and happens automatically
inside Go.

Import is deliberately separate. `fased-signerd admin wallet import` accepts
exactly one Solana CLI 64-byte JSON keypair array from standard input through
the signer-only control socket. It rejects seed phrases, command-line secrets,
environment secrets, base58 strings, hex, base64, and arbitrary JSON.

For Hosting, prepare the keypair in a root-only file. Start a root shell for the
redirection, then change only the signer process to the dedicated account. This
also works from a non-root administrator session; a plain
`sudo -u fased-signer ... < /root/file` does not, because the calling shell tries
to open the root-only file before `sudo` runs:

```bash
sudo /bin/sh -c 'exec sudo -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin wallet import \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --locked-role agent \
  < /root/offline-agent-keypair.json'
```

For Local Linux, macOS, or WSL2:

```bash
"$HOME/.fased/bin/fased-signerd" admin wallet import \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id agent \
  --locked-role agent \
  < "$HOME/private/offline-agent-keypair.json"
```

The native client creates a private `0600` staging file, fsyncs it, asks the
signer to consume it atomically, and removes it. It prints only the public
wallet record. Securely remove the source file according to your backup and
recovery procedure after confirming the public address.

<Warning>
Do not paste a private key into the dashboard, chat, a skill, an environment
variable, a command argument, or `fased wallet setup`. Do not use a seed or
recovery phrase. Import only the individual Solana account's 64-byte CLI JSON
keypair through the native admin command.
</Warning>

## Policy is signer-owned and fail closed

Every wallet has a versioned policy and hash. The policy must explicitly name:

- wallet id and permanent role;
- allowed typed operations;
- exact program ids;
- assets or mints;
- destinations;
- positive per-transaction and daily caps.

Missing policy, an empty operation/program/asset/destination list, a stale
version, a mismatched hash, or an unsupported protocol capability grants no
signing authority.

Use the installed owner-policy helper rather than editing runtime JSON and
assuming it reached the signer. The helper shows the normalized diff and exact
hash, requires operator confirmation, writes through the control socket, then
verifies the acknowledged version/hash.

Registry handles and native ids are not always identical. For example,
`@wallet:agent-2` maps to signer wallet id `agent_2`. Use the exact canonical id
printed by setup in policy and native admin input.

Copy the installed role template to a private absolute path, edit its wallet id
and permissions, then activate it. Local example:

```bash
cp "$HOME/.fased/share/signer-policies/<role>.json.template" \
  /secure/absolute/policy.json
chmod 0600 /secure/absolute/policy.json
"$HOME/.fased/bin/fased-signer-policy" \
  --initial-install \
  --policy-file /secure/absolute/policy.json
```

Hosting example:

```bash
sudo cp /usr/local/share/fased/signer-policies/<role>.json.template \
  /root/fased-<role>-policy.json
sudo chmod 0600 /root/fased-<role>-policy.json
sudoedit /root/fased-<role>-policy.json
sudo /usr/local/sbin/fased-signer-policy \
  --initial-install \
  --policy-file /root/fased-<role>-policy.json
```

The helper shows the normalized diff/hash, asks for confirmation, writes
through the control socket, and verifies the exact durable acknowledgement.

## Two RPC planes

Each native wallet needs both:

- a signer execution RPC, encrypted and versioned in signer state, for native
  balance reads, construction, simulation, broadcast, and reconciliation; and
- a Gateway read/preparation RPC for dashboard token inventory, SAT
  inspection/watchers/readiness, federation/bond reads, Jupiter/Trigger
  preparation, and provider/hardware lanes.

The simple wizard stores the chosen endpoint in both planes, so its URL/token
is visible to Gateway code. A stronger deployment uses a separate Gateway
read-only endpoint/credential. Gateway environment variables do not control
protocol-v2 execution, and the Gateway has no arbitrary RPC proxy through the
signer.

The admin client reads one strict JSON document from stdin. Keep the document
in a private `0600` file so its URL/token do not enter shell history:

```json
{
  "expectedVersion": 0,
  "primaryRpcUrl": "https://your-primary-provider.example/solana",
  "fallbackRpcUrl": "https://your-fallback-provider.example/solana"
}
```

Hosting example:

```bash
sudo /bin/sh -c 'exec sudo -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin network put \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  < /var/lib/fased-signerd/admin/agent-network.json'
```

Local example:

```bash
"$HOME/.fased/bin/fased-signerd" admin network put \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id agent \
  < "$HOME/.fased/admin/agent-network.json"
```

HTTPS is required except for an explicit loopback development endpoint. Health
returns readiness plus version/hash metadata, not the secret URL.

## Signer-owned Jupiter Trigger credential

Jupiter Trigger authentication belongs to `fased-signerd`, not Gateway. The
Trigger API key and derived JWT must never be placed in Fased config, a Gateway
environment variable, a CLI option, or a browser form. This is distinct from
`FASED_JUPITER_API_KEY`, which Gateway may use only to craft ordinary Jupiter
swap transactions for signer review.

Create a private input file and stream it to the native admin command. Local:

```bash
chmod 600 /absolute/path/to/jupiter-trigger.key
"$HOME/.fased/bin/fased-signerd" admin jupiter api-key-install \
  --output "$HOME/.fased/wallet/jupiter-trigger-api.key" \
  < /absolute/path/to/jupiter-trigger.key
fased gateway restart
```

Hosting must be configured only from the provider root console. The `app`
account cannot access signer storage or use signer sudo:

```bash
chmod 600 /root/jupiter-trigger.key
/usr/sbin/runuser -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin jupiter api-key-install \
  --output /var/lib/fased-signerd/jupiter-trigger-api.key \
  < /root/jupiter-trigger.key
systemctl restart fased-signerd.service
```

The admin command accepts the secret only on stdin, validates printable
single-line input, atomically replaces a signer-owned `0600` non-symlink file,
and never prints the key. Health exposes only `jupiter.triggerConfigured`.
Without this file, all other wallet and mining features remain available while
Trigger history/create/cancel fail closed. Use `api-key-status` or
`api-key-remove` with the same `--output` path; restart the signer after a
change. Local Docker uses the dedicated procedure in
[Docker](/install/docker#local-security-boundary).

## WebAuthn manual approval

Signer-owned WebAuthn is the authorization path for every manual native Agent,
Mining, or Vault review. The challenge binds the exact wallet, role, decoded
transaction, policy hash, request id, nonce, and short expiry. It is verified
and consumed inside Go. Narrow autonomous Agent and generated Mining operations
instead require their explicit typed policy and durable caps.

Hosting installs a root operator launcher:

```bash
sudo /usr/local/sbin/fased-signer-enroll "Primary security key"
```

Local and Local Docker expose an equivalent loopback-only enrollment flow.
Enrollment is global and requires no wallet, policy, or RPC, but it never makes
an empty or deny-all wallet policy executable. The Wallets Access-tab Wallet
Control Passkey is separate Gateway authentication; it cannot enroll or remove
signer credentials.

Passkey approval is not the same as hardware transaction display. The Control
UI is served by the Gateway. For high-value Vault/reserve funds, prefer a
hardware-backed Wallet Standard account and confirm the transaction on the
device, or use a reviewed provider policy such as Turnkey.

## Typed operations and durable limits

The application socket accepts typed SOL/SPL, SAT, Jupiter, Trigger, Vault
bond, federation, review, and reconciliation operations only. It rejects raw
instructions, arbitrary serialized transactions, and generic signing.

The signer stores request ids, immutable transaction digests, cap reservations,
daily totals, signed bytes, and final/unknown state in bbolt. Restarting does
not reset limits. Concurrent duplicates cannot both reserve the same allowance.
An ambiguous broadcast consumes its reservation and is reconciled by exact
signature; Fased never creates a replacement transaction automatically.

## Local files

The default Local material directory is `~/.fased/wallet`:

- `local-signer.sock`: typed application socket;
- `local-signer-control.sock`: same-user native admin socket;
- `signerd-v2.db`: encrypted signer, policy, WebAuthn, network, cap, and request
  state;
- `signerd-v2.master.key`: owner-only signer master key;
- `jupiter-trigger-api.key`: optional owner-only Trigger credential, never
  readable by Gateway;
- `local-signer.audit.jsonl`: signer audit stream;
- `provider-registry.v1.json`: public provider/wallet registry used by the
  runtime;
- `wallet-send-approvals.json`: Gateway-side reviewed-request state;
- `wallet-audit.jsonl`: Gateway wallet audit trail.

Do not copy only `provider-registry.v1.json` and assume the wallet is backed up.
Back up signer state and recovery material under an offline procedure, keep
file ownership/modes intact, and test recovery with public-address checks.

## Role guidance

- **Agent:** keep a limited working balance and explicit SOL/SPL destinations,
  mints, programs, and positive caps.
- **Mining:** allow only generated SAT operations and the SOL/SAT movement
  needed for mining, fees, claims, and reviewed sweeps.
- **Vault:** manual-only; use signer WebAuthn for native hot/warm use and prefer
  hardware Wallet Standard or a strong provider policy for reserve value.

Keep Agent, Mining, Vault, and long-term reserve as separate accounts. A
working balance is the amount you deliberately accept as the maximum exposure
of that role, not an unlimited general wallet.

## Archive/remove from Fased

There is no native secure key-delete operation. The guarded archive action
first tightens the exact signer policy to deny-all and verifies the durable
acknowledgement. Only then does it detach Mining/bond assignments and remove the
Gateway registry/read configuration. If locking fails, removal stops.

The encrypted signer-owned key remains in signer storage and can be recovered
by a host administrator who deliberately re-registers it and installs a new
reviewed policy. Archive is not cryptographic erasure.

## Health and recovery

```bash
fased wallet signer doctor --json
fased wallet status --json
fased doctor
```

If signer state is corrupt or has an unsupported version, Fased fails closed
and preserves the file. Do not delete it to make the error disappear. Restore
from a verified backup or use the documented signer-admin migration/recovery
path.

On Hosting, a cold Gateway restart does not start the signer with Gateway sudo.
Systemd owns signer lifecycle and starts it independently before the Gateway
uses the application socket.

## Related docs

- [Wallet signer and provider architecture](/plugins/crypto/wallet-signer-provider-architecture)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Self-hosted wallet VPS validation](/plugins/crypto/wallet-self-hosted-vps)
- [Wallet Control Passkey](/plugins/crypto/wallet-control-passkey)
- [Solana RPC setup](/plugins/crypto/wallet-rpc-setup)
- [Windows (WSL2)](/platforms/windows)
- [Docker (Local only)](/install/docker)
