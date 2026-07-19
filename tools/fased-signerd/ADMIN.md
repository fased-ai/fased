# Native signer administration

`fased-signerd admin` performs wallet lifecycle, policy and network management,
and WebAuthn enrollment through the signer-only `0600` control socket. Every
command requires the absolute control-socket path. The client rejects unknown
flags, positional data, secret flags and secret-bearing Fased environment
variables.

On a hosted installation, run these commands only from an authenticated host
administrator session as the dedicated signer user:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  policy get \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

The Gateway user must not own, read, or connect to the control socket. Do not
add an HTTP, Gateway, Node.js, MCP, or generic socket relay for these commands.

For a Local install on Linux, native macOS, or inside WSL2, run the same native
client as the signed-in user that owns the signer process and socket:

```bash
"$HOME/.fased/bin/fased-signerd" admin wallet create \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id agent \
  --locked-role agent
```

Native Windows PowerShell is not a supported signer environment because the
protocol uses Unix sockets; run the Local command inside WSL2. Do not use
`sudo` for a same-user Local signer.

## Create a signer-owned wallet

A new wallet must start with either an explicit reviewed policy file or an
explicit locked role. A locked wallet has a durable deny-all policy and cannot
sign until a host administrator installs a versioned policy.

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet create \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --locked-role agent
```

Allowed locked roles are `agent`, `mining`, and `vault`. To create with a
reviewed policy instead, replace `--locked-role` with an absolute
`--policy-file` path. Policy JSON is strict; unknown fields fail.

Example deny-all policy file:

```json
{
  "walletId": "agent",
  "role": "agent",
  "operations": [],
  "programs": [],
  "assets": []
}
```

## Import a Solana CLI keypair

Import accepts exactly one Solana CLI 64-byte JSON keypair array from standard
input. Private material is never accepted in a command argument or environment
variable. The native client validates the seed/public-key pair, creates an
exclusive signer-owned `0600` staging file in a private import directory beside
the control socket, writes and fsyncs it, asks the signer to consume it
atomically, then removes it on success or failure.

The import command must run as the control-socket owner. Use a root shell for
the input redirection, then change only the signer process to the signer user.
This works from a non-root administrator session; a plain
`sudo -u fased-signer ... < /root/file` fails because the calling shell opens
the root-only file before `sudo` runs:

```bash
sudo /bin/sh -c 'exec sudo -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin wallet import \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --locked-role agent \
  < /root/offline-agent-keypair.json'
```

The command prints only the public wallet record and policy. It never prints or
logs the imported keypair. Delete the offline source according to your custody
procedure after verifying the public address and backup.

## Read and replace policy

Read the current policy and note its `version` and `hash`:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  policy get \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

Policy replacement requires optimistic concurrency. Pass the exact current
version and an absolute strict JSON policy file:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  policy put \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --expected-version 1 \
  --policy-file /var/lib/fased-signerd/admin/agent-policy.json
```

The signer normalizes the policy, increments its version, computes the policy
hash, and invalidates incompatible pending reservations. Empty operations,
programs, or assets grant nothing.

## Configure signer-owned Solana RPC

Protocol-v2 execution and reconciliation never read Gateway RPC environment
variables. Each signer-owned wallet needs its own versioned RPC configuration
before it can execute; otherwise the signer returns `network-pending` without
reserving spend. URLs and provider tokens are encrypted with the signer master
key in the signer-owned state database. Network reads and health return only
`configured`, `version`, keyed `hash`, and readiness metadata.

RPC URLs are accepted only as one strict JSON object on standard input. Do not
put a provider URL or token in a command argument, environment variable, shell
history, or inline here-document. On Hosting, first create a root-only input
file using a trusted editor:

```bash
sudo install -d -m 0700 /var/lib/fased-signerd/admin
sudo install -m 0600 /dev/null /var/lib/fased-signerd/admin/agent-network.json
sudoedit /var/lib/fased-signerd/admin/agent-network.json
```

The initial file is:

```json
{
  "expectedVersion": 0,
  "primaryRpcUrl": "https://your-primary-provider.example/solana"
}
```

Normal onboarding needs no other field and does not ask for a cluster. For
advanced failover, add `executionFallbackRpcUrl`; the signer requires live
same-genesis agreement before Ready and again before fallback execution use. For custom/Localnet ALT
verification, or when the primary is the official public RPC, add a distinct
`verificationRpcUrl`. Legacy `fallbackRpcUrl` input is accepted only as an
execution-fallback migration alias and is rewritten using the new schema.

Apply it through the signer-only control socket. The root shell opens the
root-only file, then the admin client runs as `fased-signer` with that inherited
standard input. The client receives neither the path nor content in its process
arguments:

```bash
sudo /bin/sh -c 'exec sudo -u fased-signer -- \
  /opt/fased/signer/fased-signerd admin network put \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  < /var/lib/fased-signerd/admin/agent-network.json'
```

Remove the temporary input file after checking the returned metadata. Read the
current metadata before replacement and put its exact current `version` in the
next stdin document:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  network get \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

For Local Linux, native macOS, or WSL2, create the same `0600` JSON document in
a private directory and run the same-user client:

```bash
umask 077
mkdir -p "$HOME/.fased/admin"
"${EDITOR:-vi}" "$HOME/.fased/admin/agent-network.json"
"$HOME/.fased/bin/fased-signerd" admin network put \
  --control-socket "$HOME/.fased/wallet/local-signer-control.sock" \
  --wallet-id agent \
  < "$HOME/.fased/admin/agent-network.json"
```

## Jupiter Trigger API key

Trigger authentication is signer-owned. Install the API key from stdin into a
private path beside the signer database; never pass the key in argv or an
environment variable:

```bash
fased-signerd admin jupiter api-key-install \
  --output /absolute/signer-owned/jupiter-trigger-api.key \
  < /absolute/owner-only/jupiter-trigger.key
```

The command validates a single printable non-space ASCII value, writes a new
`0600` file with fsync plus atomic rename, rejects symlinks and unsafe ownership
or modes, and prints no credential. Restart `fased-signerd` after install or
removal. `api-key-status` and `api-key-remove` accept the same `--output` path.
These file-management commands do not use the control socket, but they must run
as the OS account that owns the signer credential directory.

HTTPS is required. Plain HTTP is accepted only for a loopback Local development
endpoint such as `http://127.0.0.1:8899`. URL user information, fragments,
unsafe metadata IP literals, link-local addresses, multicast addresses, and
oversized URLs are rejected. Repeat the operation separately for every wallet
that executes transactions.

Installing the credential still leaves Jupiter swap and Trigger execution
disabled. This release is preview-only: `review.prepare` may produce an exact
review, but `v2.execute` and `v2.review.execute` reject Jupiter/Trigger intents
unless a release-qualification operator deliberately starts the signer with
`FASED_WALLET_JUPITER_LIVE_ENABLED=1`. Normal Local and Hosting installers do
not set that variable. Health exposes only `jupiter.liveEnabled`; production
policy must keep the Jupiter/Trigger operations absent until live qualification
for the exact release is published.

## Re-encrypt wallet state

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet reencrypt \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

This rewrites the existing private key under a new authenticated-encryption
nonce and record version. It is not public-address/key rotation.

## Rotate to a new signer-owned address

Address rotation is a two-phase host-administration workflow. It never replaces
or deletes a funded key in place, and it never moves funds automatically. First
read the source wallet and policy, record their exact public key and versions,
choose a new wallet ID, then prepare a distinct signer-generated successor:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet rotate-successor \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --successor-wallet-id agent_2026 \
  --expected-source-public-key SOURCE_PUBLIC_KEY \
  --expected-source-wallet-version 1 \
  --expected-source-policy-version 3
```

The command returns public metadata only. Go creates and encrypts a new key
inside signer storage, gives it the source wallet's immutable role, and installs
an explicit deny-all policy. An exact retry returns the same prepared rotation;
a different successor is rejected. Inspect the durable status at any time:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet rotation-status \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

Back up the successor according to the custody procedure, register its public
address with external systems, and transfer source assets through separately
reviewed transactions. Confirm balances and in-flight transactions before
retiring the source. Commit by copying every exact public binding and version
from fresh wallet, policy, and rotation status reads:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet rotation-commit \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent \
  --successor-wallet-id agent_2026 \
  --rotation-id sha256:ROTATION_DIGEST \
  --expected-source-public-key SOURCE_PUBLIC_KEY \
  --expected-successor-public-key SUCCESSOR_PUBLIC_KEY \
  --expected-source-wallet-version 1 \
  --expected-source-policy-version 3 \
  --expected-successor-wallet-version 1 \
  --expected-successor-policy-version 1 \
  --expected-rotation-version 1
```

Commit is one bbolt transaction: the source receives a new permanent deny-all
policy and retirement link, source WebAuthn authorizations are invalidated, and
the rotation becomes committed. The encrypted source key and historical
operation records remain for recovery and reconciliation, but the source can
never sign or accept another policy. The successor remains deny-all until a
host administrator deliberately installs its reviewed policy with `policy put`.
If commit loses its response, `rotation-status` is authoritative; an exact
commit retry is idempotent.

## Enroll and inspect WebAuthn credentials

Registration begin returns a challenge ID and browser credential-creation
options:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  webauthn registration begin \
  --control-socket /run/fased-signerd/control.sock \
  --label "Primary security key"
```

After the browser completes `navigator.credentials.create`, store this strict
JSON object in a non-world-writable file readable by the signer user:

```json
{
  "challengeId": "the-begin-command-challenge-id",
  "credential": {
    "id": "browser-response-id",
    "rawId": "browser-response-raw-id",
    "type": "public-key",
    "response": {}
  }
}
```

Finish registration through the control socket:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  webauthn registration finish \
  --control-socket /run/fased-signerd/control.sock \
  --request-file /var/lib/fased-signerd/admin/webauthn-finish.json
```

List public credential metadata together with its optimistic `version` and
`count` fence:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  webauthn credentials list \
  --control-socket /run/fased-signerd/control.sock
```

RP ID and exact allowed origins remain root-owned daemon configuration. The
admin command cannot override them.

Revoke by copying the exact public credential ID, version, and count from a
fresh list. The signer removes it atomically, increments the membership version,
invalidates every pending WebAuthn ceremony, and destroys unused proofs issued
by that credential:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  webauthn credentials revoke \
  --control-socket /run/fased-signerd/control.sock \
  --credential-id PUBLIC_BASE64URL_CREDENTIAL_ID \
  --expected-count 2 \
  --expected-version 4
```

Removing the final credential is refused by default because it disables new
reviewed approvals. Only an authenticated host administrator who has planned
re-enrollment may repeat the command with `--confirm-last-credential`. The
credential ID is public metadata; credential public keys and private
authenticator material are never printed by the revoke command.

## Capacity monitoring and replay-safe archival

Signer health reports `state.capacities` for wallets, live operations, the
operation replay archive, reviews, and Trigger workflows. Each entry includes
`used`, `maximum`, `warnAt`, and `warning`. The warning threshold is 80% of the
hard fail-closed limit. `fased wallet signer doctor --json` turns every active
capacity warning into a failed `state.capacity.*` check; monitor that command
and the service logs.

Confirmed and failed operation details remain in the live ledger for 90 days.
Signer-owned retention then atomically replaces each live record with a
SHA-256 request-ID tombstone in `operation-replay-archive`. A request ID found
there is permanently rejected, so compaction recovers live-ledger capacity
without reopening replay. Broadcast, unknown, and reserved operations are
never archived. The replay archive itself is capped at 1,000,000 records and
warns at 800,000. Never delete, rebuild, or omit that bucket to recover space.

For a Hosting evidence snapshot, quiesce both services and archive the complete
signer directory as one root-only unit:

```bash
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sudo systemctl stop fased-gateway.service
sudo systemctl stop fased-signerd.service
sudo install -d -m 0700 /var/backups/fased-signerd
sudo tar --create --numeric-owner \
  --file "/var/backups/fased-signerd/state-$stamp.tar" \
  --directory /var/lib fased-signerd
sudo sha256sum "/var/backups/fased-signerd/state-$stamp.tar" | \
  sudo tee "/var/backups/fased-signerd/state-$stamp.tar.sha256" >/dev/null
sudo chmod 0600 "/var/backups/fased-signerd/state-$stamp.tar" \
  "/var/backups/fased-signerd/state-$stamp.tar.sha256"
sudo systemctl start fased-signerd.service
sudo systemctl start fased-gateway.service
fased wallet signer doctor --json
```

The archive contains encrypted keys, the master key, WebAuthn state, policies,
network credentials, live operations, replay tombstones, and audit records. It
is a high-sensitivity custody backup: encrypt it with an owner-controlled
offline key before moving it off host, restrict access, and test checksum plus
tar readability without extracting into a live state directory.

This procedure does not start a new ledger generation and does not authorize
deleting live state. A snapshot becomes stale as soon as signing resumes.
Restoring a snapshot after any newer operation could omit a replay tombstone;
therefore restore only a provably latest quiesced snapshot. If that cannot be
proven, do not resume autonomous signing from it: keep the signer isolated,
install deny-all policies through the control socket, rotate to new wallet
identities, and recover funds through separately reviewed owner transactions.
Never merge two bbolt files or restore `state.db` without the matching complete
signer directory.

For Local Linux, WSL2, or macOS, stop the Gateway and local signer first, then
archive the complete owner-only `$HOME/.fased/wallet` directory with `umask 077`.
The same stale-snapshot and no-ledger-reset rules apply.

## Retry safety

If a mutating command loses the response after writing its request, inspect
wallet, policy, or network state before retrying. The client reports this
explicitly for an unreadable response. Never assume a failed client connection
means the signer did not commit the operation.
