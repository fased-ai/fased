# fased-signerd

`fased-signerd` is FasedAgent's native signer. It owns wallet keys, durable
policy and cap state, typed transaction validation, reviewed WebAuthn
authorization, signing, and broadcast reconciliation.

The normal command starts the signer daemon. Administrative wallet lifecycle
operations use the same verified binary through the private control socket:

```text
fased-signerd admin ...
```

The admin client is intentionally a small set of typed commands, including
fenced successor-address rotation and WebAuthn credential revocation. It is not a
generic control-socket proxy and must never be exposed through the Gateway or
an HTTP route. Hosted operators run it as the dedicated signer operating-system
user from an authenticated root session; the Gateway account receives no sudo
or control-socket access.

See:

- [Signer administration](./ADMIN.md)
- [Signer-owned WebAuthn](./WEBAUTHN.md)
