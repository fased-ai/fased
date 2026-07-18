---
summary: "The separate Gateway Wallet Control Passkey and native signer WebAuthn authorization paths."
read_when:
  - Distinguishing the Wallets Access passkey from native signer WebAuthn
  - Enrolling a credential for native wallet reviews
  - Comparing passkey approval with hardware-wallet transaction display
title: "Wallet Control Passkey"
sidebarTitle: "Wallet passkey"
---

# Wallet Control Passkey

Fased has two separate WebAuthn layers:

- **Wallet Control Passkey** in the Wallets **Access** tab is Gateway-owned. It
  authenticates approval requests and settings changes handled by the Gateway.
- **Signer WebAuthn** is Go-owned. Its credential, exact review challenge, and
  single-use consumption live inside `fased-signerd`.

They are different credential sets. Enrolling or removing a Wallet Control
Passkey in the Gateway UI does not enroll, list, or remove a signer credential.
The Gateway UI cannot administer signer credentials.

## What signer WebAuthn authorizes

A manual signer review binds the WebAuthn challenge to:

- wallet id and permanent role;
- exact typed operation;
- immutable transaction or federation digest;
- decoded destinations, mints, and amounts;
- signer policy version and hash;
- request id, nonce, and short expiry.

An assertion can execute only that review and is consumed once. Every manual
native reviewed Agent, Mining, or Vault operation uses this path. Narrowly
autonomous Agent operations and generated Mining operations instead rely on
their explicit signer policy and durable caps.

Wallet Control Passkey remains useful Gateway authentication, but a token that
names only the host, operation, or Gateway request is not signer custody
authorization and cannot satisfy this challenge.

## What it does not do

WebAuthn does not:

- make a deny-all or missing policy executable;
- allow raw signing or arbitrary serialized transactions;
- turn a Vault into an autonomous wallet;
- prove the browser is showing honest transaction intent;
- protect a Local same-user install from a fully compromised OS account;
- replace an offline backup/recovery procedure.

The Control UI is served by the Gateway. For high-value manual Vault work, a
hardware wallet that displays the account and transaction on-device is a
stronger review surface.

## Enrollment prerequisites

- the version-matched native signer is healthy;
- the enrollment origin/RP configuration matches the loopback ceremony;
- the operator is connected locally or through the private Hosting admin path.

Signer enrollment is global; no wallet, policy, or RPC is required merely to
register the credential. Before executing a review, separately verify the
wallet id/role/address, explicit policy hash, and both RPC planes:

```bash
fased wallet signer doctor --json
fased wallet status --json
```

## Enroll on Local Linux, macOS, or WSL2

Use the loopback-only enrollment launcher installed with the signer. Run it as
the same signed-in user that owns the Local signer. Do not use native Windows
PowerShell; run it inside WSL2 Ubuntu.

```bash
"$HOME/.fased/bin/fased-signer-enroll" "Primary security key"
```

The launcher prints a short-lived `http://localhost:18791/...` URL. On WSL2,
open that exact URL in the normal Windows browser through WSL localhost
forwarding. Never create a Windows `portproxy` or firewall rule for port
`18791`. Verify the signer lists the new public credential metadata.

## Enroll on VPS Hosting

The Gateway account cannot reach the control socket and has no signer sudo.
Start enrollment from an authenticated host-administrator session:

```bash
sudo /usr/local/sbin/fased-signer-enroll "Primary security key"
```

Use the private loopback/Tailscale procedure printed by the launcher. Do not
expose an enrollment port publicly and do not add a Gateway/HTTP relay to the
control socket.

## Local Docker

Local Docker provides a one-shot loopback-only enrollment helper that talks to
the signer control socket without mounting signer state into the Gateway. Use
the exact command in [Docker](/install/docker).

Docker support is Local only. Do not use it as a replacement for the Hosting
signer account/service boundary.

## Review and execute

The Wallets page renders the exact review intent. Confirm the source,
destination, mint, amount, decoded programs, policy hash, request id, and
expiry. Gateway approval authentication may happen first; signer WebAuthn is
then completed for the exact native review. Neither gate substitutes for the
other.

If a result is uncertain:

- do not click repeatedly;
- do not change parameters and try again;
- query the existing review/request state;
- reconcile the stored signature or signed bytes.

Signed expired reviews may be recovered only from the exact signer-owned
artifact. Unsigned expired reviews are rejected.

## Credential operations and recovery

The current native admin protocol supports signer credential registration and
listing; it does not support signer credential removal. Do not mistake the
Gateway UI's Wallet Control Passkey removal button for native signer removal.
Keep recoverable authenticators according to your security model and record
only public credential metadata; never store a wallet key or recovery phrase in
the passkey file.

If signer WebAuthn state is corrupt, Fased fails closed and preserves it. Do not
delete the state to bypass approval. Restore or repair it using the native
admin procedure and confirm the wallet/policy hashes before resuming.

## Passkey versus custody lane

| Control                         | Best use                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| Gateway Wallet Control Passkey  | Authenticate Gateway approvals and settings; not signer custody          |
| Native signer WebAuthn          | Exact manual native Agent, Mining, or hot/warm Vault review              |
| Wallet Standard hardware wallet | On-device manual Vault review; Fased stores public address only          |
| Turnkey policy                  | Provider-managed manual signing under an independent organization policy |
| Agent signer caps               | Narrow unattended Agent authority; not a passkey replacement             |
| Mining typed policy             | SAT-only automation plus configured SOL fee/capital movement             |

The old split-passphrase/custody-unlock model is not the production custody
path. Do not rely on legacy split-key UI or Node custody routes.

## Related docs

- [Wallet operations and security](/plugins/crypto/wallet-production-flow)
- [Self-hosted wallet signer](/plugins/crypto/wallet-self-hosted)
- [Wallet signer architecture](/plugins/crypto/wallet-signer-provider-architecture)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Windows (WSL2)](/platforms/windows)
