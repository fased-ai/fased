---
summary: "Configure the separate signer execution and Gateway read/preparation Solana RPC planes."
read_when:
  - Preparing a native Agent, Mining, or Vault wallet
  - Fixing signer network-pending or RPC readiness
title: "Solana RPC Setup"
sidebarTitle: "RPC setup"
---

# Solana RPC setup

Normal onboarding asks for only the wallet role and one primary Solana RPC per
wallet. It does **not** ask the user to select a Solana network. The native
signer reads and pins the primary endpoint's live genesis hash before the
wallet network can become ready. SAT Mining infers its internal network value
by matching that live cluster to official public endpoints; the value is not a
user-facing onboarding choice.

Fased separates three endpoint roles:

- **Signer execution RPC:** encrypted and versioned per native wallet. It powers
  native balance reads, construction, simulation, broadcast, and reconciliation.
- **Gateway read/preparation RPC:** powers dashboard token inventory, SAT
  inspection/watchers/readiness, federation/bond reads, Jupiter/Trigger
  preparation, and provider/hardware custody lanes.
- **Verification witness:** the matching official public endpoint selected by
  live genesis-hash agreement. It is used only for sensitive ALT account-byte
  and slot agreement; it never constructs, simulates, broadcasts, reconciles,
  or supplies execution balances/blockhashes.

Gateway wallet environment variables are not authority for protocol-v2 native
execution, and the Gateway has no arbitrary RPC proxy through the signer. They
remain necessary for Gateway-owned reads and preparation.

The simple setup wizard stores the selected endpoint in both planes. Therefore
that URL/token is visible to Gateway code. For stronger separation, use a
different read-only endpoint/credential for the Gateway and keep the execution
credential only in signer-owned encrypted state.

## Provider posture

Use a reliable private/commercial mainnet provider for unattended mining and
wallet actions. A public endpoint is suitable for limited testing but should
not be your production reliability or privacy assumption.

Keep provider URLs/tokens out of:

- chat, prompts, screenshots, issues, and channel messages;
- skill files and task instructions;
- command arguments and shell history;
- command-line flags and unencrypted ad hoc files;
- public logs.

The Gateway read endpoint necessarily remains visible to the Gateway. Give it
only the provider permissions/quota appropriate for public-chain reads; do not
reuse a privileged signer execution credential there.

## Prepare the input document

RPC changes use optimistic concurrency. Read current public metadata first:

```bash
# Hosting
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  network get \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id mining

# Local Linux, macOS, or WSL2
"$HOME/.fased/bin/fased-signerd" admin network get \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id mining
```

Create a private `0600` JSON file with that exact current version. Initial
configuration uses version `0`:

```json
{
  "expectedVersion": 0,
  "primaryRpcUrl": "https://YOUR_PRIMARY_PROVIDER/solana"
}
```

That is the complete normal configuration. Advanced users may add an optional
second full execution provider as `executionFallbackRpcUrl`. The signer admits
it only after live same-genesis agreement and rechecks that agreement before
the fallback can be returned for execution. A custom cluster, Localnet, or an official public primary needs a distinct
`verificationRpcUrl` (or a same-cluster execution fallback) before ALT is
enabled. These fields are not normal onboarding questions.

Existing `fallbackRpcUrl` records migrate only to `executionFallbackRpcUrl`;
they never silently become verification witnesses. HTTPS is required except
for an explicit loopback development endpoint such as
`http://127.0.0.1:8899`. Every secondary must use a distinct origin. URLs with
userinfo, fragments, unsafe metadata/link-local/multicast addresses, or
oversized content are rejected.

## Apply on VPS Hosting

Create the file as root with a trusted editor:

```bash
sudo install -d -m 0700 /var/lib/fased-signerd/admin
sudo install -m 0600 /dev/null /var/lib/fased-signerd/admin/mining-network.json
sudoedit /var/lib/fased-signerd/admin/mining-network.json
```

Open the root-only file for stdin before running the native admin client as the
signer user:

```bash
sudo /bin/sh -c 'exec sudo -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin network put \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id mining \
  < /var/lib/fased-signerd/admin/mining-network.json'
```

The Gateway account cannot reach the control socket and has no sudo access.
Remove the temporary input file after verifying the returned version/hash.

## Apply on Local Linux, macOS, or WSL2

Run as the same user that owns the Local signer:

```bash
umask 077
mkdir -p "$HOME/.fased/admin"
"${EDITOR:-vi}" "$HOME/.fased/admin/mining-network.json"
"$HOME/.fased/bin/fased-signerd" admin network put \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id mining \
  < "$HOME/.fased/admin/mining-network.json"
```

On Windows, run this inside WSL2 Ubuntu, not PowerShell, Command Prompt, Git
Bash, or native Windows Node.js.

## Configure every wallet independently

Repeat `network put` for each signer-owned Agent, Mining, or Vault wallet that
will execute. A ready Mining RPC does not make Agent or Vault ready.

The signer returns only public metadata such as:

- configured/readiness state;
- version;
- keyed configuration hash;
- last health/error category.

It does not return the provider URL/token.

## Configure the Gateway read plane

Onboarding and **Manage wallet > Configure Solana RPC** save the per-wallet
Gateway read endpoint and initially send the same value to the signer. The
Gateway mapping uses the registry id normalized to an uppercase underscore
suffix, for example `agent-2` becomes
`FASED_WALLET_SOLANA_RPC_URL__AGENT_2`.

For separation, enter a read-only endpoint in the wizard, then use the native
`network get`/`network put` flow above to replace only the signer execution RPC
with its private credential. Recheck both planes. Do not assume signer health
proves the dashboard/SAT watcher endpoint works, or that a Gateway read succeeds
through the signer.

The Gateway may use the official public endpoint as a read-only fallback. That
does not promote it into the signer execution plane. Public Solana endpoints
are rate-limited and should not be the primary production endpoint.

## Validate

```bash
fased wallet signer doctor --json
fased wallet status --json
fased mining readiness --wallet mining
```

Do not fund/deposit mining capital or enable Agent automation until signer
network health, Gateway reads, and the exact signer policy version/hash all pass.

## Update and recovery

For replacement, read the current version and put a new document with that
exact `expectedVersion`. Stale writers fail.

If network state is corrupt or the master key cannot decrypt it, the signer
fails closed. Preserve the state; do not delete it or move the URL into Gateway
environment variables as a bypass. Restore/repair through the native admin
procedure.

After an RPC timeout during broadcast, reconcile the exact stored signature or
signed bytes. Never change endpoints/parameters and automatically submit a
replacement transaction.

## Related docs

- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Mining troubleshooting](/plugins/crypto/mining-troubleshooting)
