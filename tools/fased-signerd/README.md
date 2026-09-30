# fased-signerd

`fased-signerd` is FasedAgent's native signer. It owns wallet keys, durable
policy and cap state, typed transaction validation, reviewed WebAuthn
authorization, signing, and broadcast reconciliation.

The normal command starts the signer daemon. Administrative wallet lifecycle
operations use the same verified binary through two private typed lanes:

```text
ordinary operator -> fased-signerd admin ... --operator-socket ...
signer owner      -> fased-signerd admin ... --control-socket ...
```

The native operator client creates the nonce, expiry, and exact release
identity required by `operator.sock`. The ordinary JavaScript application
client uses only `app.sock` and refuses operator/control sockets.

The admin client is intentionally a small set of typed commands. Recovery,
private-key export, re-encryption, and mutating successor-address rotation are
signer-owner operations and are unavailable on `operator.sock`. They run
through one-shot root-owned helpers on protected Local Linux and VPS Hosting.
The client is not a generic socket proxy and must never be exposed through the
Gateway or an HTTP route.

Protected Local Linux and VPS Hosting run the human operator, Gateway, signer,
and release controller as separate authorities. Native macOS and explicitly
unprotected same-user Local environments remain lower assurance.

See:

- [Signer administration](./ADMIN.md)
- [Signer-owned WebAuthn](./WEBAUTHN.md)

### Candidate campaign operator setup

The source candidate exposes two owner-control commands. Each reads a bounded,
strict JSON envelope from stdin and verifies the exact installation receipt:

```sh
fased-signerd admin wen-campaign install-draft --control-socket /path/to/control.sock --wallet-id miner < reviewed-draft-request.json
fased-signerd admin wen-campaign install-admission --control-socket /path/to/control.sock --wallet-id miner < reviewed-admission-request.json
```

Draft envelopes contain `draft` and `expectedSha256` (the digest of the canonical
Go JSON encoding of that draft). Admission envelopes contain `requestId` and
`expectedSha256` (the exact stored review artifact digest). These are separate
operator confirmations, not owner transaction approvals. Neither command accepts
an application RPC URL or signs a transaction. Application campaign preparation
and execution remain unregistered; this is not an installed-readiness claim.

### Explicit manual WEN Buy approval

An owner-configured `approvalMode: "manual"` policy may use an exact one-time
owner confirmation for WEN Buy. `requirePasskey: true` retains credential approval.
Policies without these fields retain their existing semantics and canonical hashes.
The control-only `v2.wenMarket.ownerApprove` operation confirms the stored request
and artifact digest; it returns an opaque signer-owned proof expiring no later than
30 seconds or the review deadline. Application and operator sockets cannot issue
this proof. Policy changes, expiry, retirement or a different artifact reject it.
Proof consumption, spending reservations and transaction recovery remain durable.

`approvalMode: "read-only"` grants no operations, programs or asset spending.
Explicit manual policies cannot use autonomous execution. A bounded automatic
Buy mandate requires an authenticated application UID, a not-before time and an
expiry no more than 24 hours later, plus the existing operation, program, asset,
spending and fee constraints. Only protected, admitted WEN Buy reviews qualify;
the mandate cannot install drafts, admission or budgets. Revocation, expiry and
executor identity are checked again at execution transitions. Recovery uses the
original journal without submitting another purchase.

Standard wallet creation and import start read-only with no operation, program
or asset grants. Internal role fields remain solely for existing-state compatibility;
ordinary setup uses generic wallet names. These paths are source-tested; installed
acceptance remains separate.
