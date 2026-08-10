# Lifecycle Contract

Read this file only when installer, updater, system service, migration, signer,
Wallet custody, Local, or Hosting product behavior changes.

## One engine

`tools/fased-lifecycled` is the sole privileged lifecycle mutation engine.

```text
installer/update CLI -> verify exact target -> fased-lifecycled
-> shared transaction -> Local or Hosting adapter -> commit or rollback
```

JavaScript may resolve, download, verify, and translate results. It must not own
a second planner, service mutator, signer migration, rollback path, or recovery
journal. Local and Hosting differ only in OS accounts, paths, services, and
network hardening.

The stable supervisor owns controller trust and selection. The target
controller owns product generation, signer coordination, services, migration,
health, and rollback. Their authority-scoped journals bind one transaction.
The Go signer exclusively owns keys, Wallet policy, network identity, audit,
and signing.

## Transaction

```text
lock -> inspect -> verify -> snapshot -> stage -> migrate -> switch
-> restart -> health/state verification -> commit -> prune
```

Failure restores the previous generation, services, and declared state before
reporting rollback. Retain only active generation, one verified previous
generation, and active staging. A repeated successful command returns
`Already current` without mutation.

Stable service identities and user data never live inside replaceable runtime
generations. Preserve Wallets, signer database/key identity, Mining state,
Network identity, configuration, plugins, and instance identity unless a
declared transactional schema migration changes representation.

## Compatibility

Select behavior by manifest schema, persisted-state schema, topology, platform,
and protocol capability—not private RC names. Support fresh install, current
managed update, latest public-stable bridge, interrupted recovery, and explicit
repair for ambiguous residue. Unknown-newer schemas fail unchanged.

Legacy JavaScript mutation owners must remain unreachable and be deleted after
their Go replacement passes the same local proof. Never dual-write one
installation.

## Required local proof

For changed lifecycle product bytes:

`focused tests -> one cached Linux-x64 artifact -> affected public command -> services and product health -> rollback/retry when affected -> restart -> state preservation -> Already current`

Use exact immutable bytes and machine-readable receipts. Fresh and update are
independent; test only affected topologies during development. Candidate P1
later replays the same contract against final bytes.

Signer changes additionally require authenticated, authorized, replay-safe
typed RPC; no secret material in JS/UI/Gateway; exact Wallet/network/policy
binding; and rollback preserving signer database and master-key identity.
Containers support Hosting adapter evidence; only an authorized real VPS proves
Hosting acceptance.
