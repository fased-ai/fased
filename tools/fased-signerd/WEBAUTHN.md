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

Reviewed signing is a two-step signer ceremony:

1. `v2.review.authorization.begin` records a short-lived challenge bound to
   wallet ID, role, canonical decoded intent and digest, exact transaction
   digest, current policy hash, request ID and a signer nonce.
2. `v2.review.authorization.finish` verifies a UV WebAuthn assertion and emits
   an opaque proof reference. The signer must atomically consume that reference
   only after the transaction-specific semantic validator has reproduced the
   exact stored binding and immediately before signing.

The proof reference is not a reusable bearer approval. Its complete record is
kept in bbolt, expires after at most 45 seconds, is checked against the current
policy, and can be consumed once.
