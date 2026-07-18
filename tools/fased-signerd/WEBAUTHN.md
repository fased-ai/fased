# Signer-owned WebAuthn

`fased-signerd` uses `github.com/go-webauthn/webauthn` for WebAuthn
registration and assertion verification. The dependency is the actively
maintained Go WebAuthn relying-party implementation, follows the WebAuthn
verification procedures, parses attestation objects and COSE public keys, and
keeps those security-sensitive formats out of Fased's own parser. Fased pins an
exact module version and retains the raw verified attestation data in the
signer-owned database so a future metadata policy can revalidate credentials.

The signer, not the Gateway, owns:

- the exact RP ID and origin allowlist;
- credential records and signature counters;
- registration and assertion sessions, expiration and single-use state;
- canonical reviewed intent, policy and transaction bindings;
- single-use reviewed-authorization proofs.

Configure the relying party in the root-owned signer service with
`--webauthn-rp-id` and `--webauthn-origins`. The origin list is comma-separated
and exact. HTTPS is mandatory except for loopback development. Requests never
carry an origin or RP override.

Credential enrollment begins and finishes only on the signer control socket.
That rule also applies to the first credential, so a compromised Gateway with
application-socket access cannot claim an uninitialized signer. Hosted service
configuration must keep the control socket inaccessible to the Gateway user.
Use the typed native commands documented in [ADMIN.md](./ADMIN.md) for the
registration ceremony. They do not expose a generic control-socket proxy.

Credential listing returns an optimistic membership version and count.
Revocation is also control-socket-only and must bind the exact public credential
ID to both values in one bbolt transaction. A successful revoke invalidates all
pending ceremonies and every unused proof issued by the removed credential.
Removing the last credential requires a separate explicit administrator flag;
otherwise the signer fails closed without mutation. See
[Signer administration](./ADMIN.md) for the typed commands.

`v2.review.prepare` receives a typed intent. For native SOL and SPL transfers,
the caller must omit transaction bytes: the signer resolves mint metadata and a
recent blockhash through its own per-wallet RPC configuration, builds the exact
unsigned transaction and simulates it. For Jupiter and Trigger operations, the
caller supplies one exact transaction envelope; the signer resolves lookup
tables, decodes and semantically validates the transaction, and simulates its
effects. In both cases the signer stores the normalized intent, exact envelope
and unsigned transaction digest as one immutable review.

Reviewed authorization is a two-step signer ceremony:

1. `v2.review.authorization.begin` accepts only the prepared request ID. The
   signer loads the non-expired review and records a short-lived challenge bound to
   wallet ID, role, canonical decoded intent and digest, exact transaction
   digest, current policy hash, request ID and a signer nonce.
2. `v2.review.authorization.finish` verifies a UV WebAuthn assertion and emits
   an opaque proof reference. The signer must atomically consume that reference
   only after the transaction-specific semantic validator has reproduced the
   exact stored binding and immediately before signing.

`v2.review.execute` accepts only the prepared request ID and, for reviewed
mode, that opaque signer proof. It reloads the stored intent and transaction;
callers cannot replace the policy, semantics, transaction digest or serialized
transaction at execution time. Autonomous review execution is restricted to
Agent-role wallets and rejects a proof.

Vault-role wallets are also rejected by direct `v2.execute`, even when their
policy permits native SOL or SPL operations. Vault transfers must use the
signer-built `review.prepare` → signer-owned WebAuthn → `review.execute` path.

The proof reference is not a reusable bearer approval. Its complete record is
kept in bbolt, expires after at most 45 seconds, is checked against the current
policy, and can be consumed once.
