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
