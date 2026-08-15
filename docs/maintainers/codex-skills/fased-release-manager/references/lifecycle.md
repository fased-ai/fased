# Lifecycle Contract

Read this file only when installer, updater, system service, migration, signer,
Wallet custody, Local, or Hosting product behavior changes.

## Public user contract

Managed users install and update with these commands only:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --hosting
```

```bash
fased update
fased update status
```

The installer may request one bounded OS authorization ceremony. It owns
platform detection, prerequisites, trust verification, lifecycle setup,
signer/Gateway setup, and unprivileged onboarding. The installed stable
launcher owns future update entry. Users never manage Node, npm, pnpm, Git, Go,
GitHub CLI, internal paths, units, or recovery journals.

An explicit `--release <tag>` must resolve completely from that immutable
GitHub Release. A channel selector must resolve through the signed monotonic
release record inside the Go trust boundary. GitHub release listings and npm
dist-tags are neither managed discovery authorities nor dependencies. Quiet
and verbose modes change output only.

The protected publisher exposes the exact immutable release first, then
advances the predictable `fased-channel-<channel>-v1` release with the exact
already-attested root/index pair and a short-lived attested root-head witness.
The witness positively binds the latest root version/digest and exact index
digest; HTTP absence never defines the end of a root chain. Protected main
refreshes that witness every six hours with a 36-hour lifetime, while clients
reject stale, missing, replayed-below-floor, or digest-mismatched witnesses.
The publisher serializes per channel, rejects sequence or security-epoch
rollback, stages replacement pairs before renaming them, and verifies public
readback. An interrupted channel transaction is fail-closed and retryable; it
never rebuilds or republishes candidate bytes.

Always distinguish `documented`, `implemented`, and `proven`. The canonical
contract, source inspection, and a literal enforcing receipt are different
evidence tiers. Never infer the third from the first two.

## One engine

`tools/fased-lifecycled` is the sole privileged lifecycle mutation engine.

```text
short installer/update CLI -> static Fased bootstrap -> root-owned inbox
-> stable fased-lifecycled host -> shared transaction
-> Local or Hosting adapter -> commit or rollback
```

The bootstrap verifies the Fased trust root, signed release index, release
sequence, and exact artifact objects without Node, npm, pnpm, GitHub CLI, or
remote setup scripts. It may install or A/B-switch the separately attested
lifecycle host. It does not own application migration policy.

JavaScript may translate user intent and results. It must not select privileged
target identity, download for root import, own a planner, mutate services,
migrate signer/state, roll back, or recover a journal. Local and Hosting differ
only in OS accounts, paths, services, and network hardening.

The installed lifecycle host is the only product root mutation owner.
Application generations never provide a root controller or root executable.
The Go signer exclusively owns keys, Wallet policy, network identity, audit and
signing.

The fixed installed launcher routes both `fased update` and
`fased update status` to the Go bootstrap before replaceable Node application
bytes start. Direct Node/package `fased update` is a non-mutating repair
redirect, and Gateway `update.run` is unavailable. The only source updater is
the explicitly developer-only `fased dev update-source`, and it must prove a
non-managed Git checkout before entering source mutation code.

## Transaction

```text
acquire -> verify -> lock -> inspect -> plan -> quiesce
-> checkpoint state -> prepare signer -> stage -> switch -> restart
-> UID/state/service/plugin verification -> commit -> prune
```

Failure restores the previous generation, services, and declared state before
reporting rollback. Retain only active generation, one verified previous
generation, and active staging. A repeated successful command returns
`Already current` without mutation.

Every mutating phase and participant writes a durable fsynced receipt. On
startup, recover the unfinished journal before accepting a new command.
In-memory undo closures are not sufficient recovery evidence.

Stable service identities and user data never live inside replaceable runtime
generations. Quiesce each state owner before capture. Treat each SQLite database
plus WAL, SHM and journal as one typed participant. Preserve Wallets, signer
database/key identity, Mining state, Network identity, configuration, plugin
data and instance identity unless a declared transactional migration changes
representation.

Executable plugin code belongs to the signed generation or an immutable
content-addressed plugin store. It is not mutable preserved state. Every
Fased-owned channel and optional runtime extension is part of the signed
application generation and updates atomically with core. Its workspace package
is a private pnpm build unit, not a separately published npm product.

Independent third-party plugin code belongs to the content-addressed store and
changes only through an explicit plugin transaction using a digest-bound
archive/catalog source. Core update never updates third-party plugins; plugin
integrity drift fails closed. npm is neither a managed lifecycle dependency nor
a release-acceptance or trust channel. A legacy public npm CLI, if temporarily
retained for migration, may only redirect the user to the verified installer;
it must never mutate a managed installation or publish extension payloads.

## Compatibility

Select behavior by manifest schema, persisted-state schema, topology, platform,
protocol capability and signed monotonic release sequence—not private RC names
or registry dist-tags. Support fresh install, current managed update, latest
public-stable bridge, interrupted recovery, explicit rollback authorization and
explicit repair for ambiguous residue. Unknown-newer state fails unchanged;
lower release sequence is rejected.

Legacy JavaScript mutation owners and candidate root-controller workers must
remain unreachable only until their replacement passes the same branch proof,
then be physically deleted. Never dual-write one installation. Compatibility
readers may remain only for a named supported predecessor topology and must not
provide a second managed mutation route.

## Required local proof

For changed lifecycle product bytes:

`focused tests -> one cached Linux-x64 artifact -> affected public command -> services and product health -> rollback/retry when affected -> restart -> state preservation -> Already current`

Use exact immutable bytes and machine-readable receipts. Fresh and update are
independent; test only affected topologies during development. Candidate P1
later replays the same contract against final bytes.

A fixture-only correction invalidates the old acceptance receipt, not unchanged
product bytes. The LOCAL0 driver may reuse an explicitly supplied ancestor
artifact only across its closed fixture/policy allowlist with an identical
lockfile. The new receipt must bind the artifact product commit/tree separately
from the exact current fixture commit/tree. Any other changed path fails closed
and rebuilds once.

Signer changes additionally require authenticated, authorized, replay-safe
typed RPC; no secret material in JS/UI/Gateway; exact Wallet/network/policy
binding; and rollback preserving signer database and master-key identity.
Containers support Hosting adapter evidence; only an authorized real VPS proves
Hosting acceptance.

Use the stable acceptance IDs in the canonical lifecycle architecture.
Fixtures with substituted transport never prove public acquisition. A D10
branch receipt may mark its independently exercised product predicates `PASS`
only when `public-installer-acquisition` remains explicitly `SUPPORTING` and
the receipt binds both statuses. Such a mixed receipt cannot close PUBLIC0,
owner Local, real Hosting, publication acquisition, or stable acceptance.
