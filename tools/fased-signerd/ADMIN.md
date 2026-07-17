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
  "primaryRpcUrl": "https://your-primary-provider.example/solana",
  "fallbackRpcUrl": "https://your-fallback-provider.example/solana"
}
```

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

HTTPS is required. Plain HTTP is accepted only for a loopback Local development
endpoint such as `http://127.0.0.1:8899`. URL user information, fragments,
unsafe metadata IP literals, link-local addresses, multicast addresses, and
oversized URLs are rejected. Repeat the operation separately for every wallet
that executes transactions.

## Re-encrypt wallet state

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  wallet reencrypt \
  --control-socket /run/fased-signerd/control.sock \
  --wallet-id agent
```

This rewrites the existing private key under a new authenticated-encryption
nonce and record version. It is not public-address/key rotation.

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

List public credential metadata:

```bash
sudo -u fased-signer -- /opt/fased/signer/fased-signerd admin \
  webauthn credentials list \
  --control-socket /run/fased-signerd/control.sock
```

RP ID and exact allowed origins remain root-owned daemon configuration. The
admin command cannot override them.

## Retry safety

If a mutating command loses the response after writing its request, inspect
wallet, policy, or network state before retrying. The client reports this
explicitly for an unreadable response. Never assume a failed client connection
means the signer did not commit the operation.
