---
summary: "Inspect Fased Network runtime state, trust, token status, and hosted routing from the CLI."
read_when:
  - You want to inspect Fased Network state from a terminal
  - You need the persisted token summary or hosted routing status
title: "federation"
---

# `fased federation`

Inspect Fased Network runtime state, token state, and hosted routing paths from the CLI.

In Fased, Fased Network is the network participation layer. The command name is
still `fased federation` because that is the current CLI/API surface. Use it to
verify whether the runtime is merely configured, actually enrolled, trusted, and
publicly reachable.

It is also the quickest terminal-side check when you need to know whether a runtime should be treated as:

- discovery-only
- trusted and reachable
- ready for public routing or marketplace-facing workflows

## Common commands

```bash
fased federation status
fased federation token
fased federation paths
fased federation bond-wallet status
```

## Commands

### `fased federation status`

Show the current Fased Network runtime picture:

- whether Fased Network is configured
- whether auto-connect is enabled
- base URL
- handle
- public origin
- token presence
- trust state
- hosted state
- public URL when present
- whether the hosted probe is healthy or broken

```bash
fased federation status
fased federation status --json
```

### `fased federation token`

Show the persisted Fased Network token summary.

This is the quickest way to inspect:

- token id
- handle
- issue and expiry times
- trust state
- hosted state
- scopes
- public URL

```bash
fased federation token
fased federation token --json
```

### `fased federation paths`

Show where Fased Network state is stored on disk.

```bash
fased federation paths
fased federation paths --json
```

### `fased federation bond-wallet status`

Show the Vault wallet currently configured for Fased Network bond.

```bash
fased federation bond-wallet status
fased federation bond-wallet status --json
```

### `fased federation bond-wallet set <walletId>`

Assign the Vault wallet that the runtime should use for Fased Network bond and bond proof.

```bash
fased federation bond-wallet set solana-2
```

### `fased federation bond-wallet clear`

Clear the configured bond Vault without deleting the wallet itself.

```bash
fased federation bond-wallet clear
```

## What this command is for

Use `fased federation` when you need:

- a quick SSH-side health read
- token inspection without opening the UI
- confirmation that hosted routing and token persistence are wired correctly
- confirmation that the public route is healthy, not just enrolled
- a fast reality check before using the runtime in public-facing network workflows

Practical reading of the output:

- `joined` or token present means Fased Network state exists
- `hostedState: ready` means the network accepted the runtime
- hosted probe health tells you whether the public route is actually serving correctly
- trust state tells you whether the network currently regards the runtime as verified, pending, revoked, or blocked

Those are not the same thing.

Another practical rule:

- Fased Network state is not the same thing as payment, SAT, or marketplace workflow readiness
- payment workflows remain separate from SAT participation logic
- hosted app browsing and self-hosted execution are different product roles

Bond note:

- this CLI group manages the configured bond Vault assignment
- the bond lifecycle itself is run through the Fased Network control surface and SAT tooling
- a separate Vault wallet is required by Fased for bond authority

It is an inspection surface, not the full join or enrollment workflow.

For setup and product context, use the onboarding and Fased Network guides.

## Related docs

- [Onboarding Wizard (CLI)](/start/wizard)
- [Onboarding Overview](/start/onboarding-overview)
- [Fased Network Guide](/start/federation)
- [Fased Agent Setup](/start/fased)
- [Gateway CLI](/cli/gateway)
