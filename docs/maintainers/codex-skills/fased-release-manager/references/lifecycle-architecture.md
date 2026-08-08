# Fased Install, Update, And Onboarding Architecture

This file is the single normative source for FasedAgent installation, update,
migration, repair, privileged services, and onboarding behavior. Test and
release documents select evidence for this contract; they do not redefine it.

The contract is version-neutral. Release numbers belong in evidence receipts,
not in reusable product logic or Codex instructions.

## User Contract

Normal users have four entry points:

| Intent                            | Entry point                                      | Result                                                            |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Fresh Local install               | documented Local installer                       | protected runtime is committed, then onboarding opens             |
| Fresh Hosting install             | documented one-curl Hosting installer            | protected runtime is committed, then onboarding opens             |
| Existing managed installation     | `fased update` or an explicitly selected channel | one transactional update, automatic rollback on failure           |
| Pre-supervisor Local installation | documented Local installer once                  | complete forward-update authority is committed without onboarding |

Rules:

- A normal update must never require a reinstall, developer harness, direct
  state edit, hidden repair command, or manual service mutation.
- A pre-supervisor Local executable, or a Protected Local installation whose
  old flat updater bundle is incomplete, cannot acquire missing capabilities
  from target code it cannot execute. The normal verified Local installer
  detects that topology and may request one operating-system authorization
  ceremony while establishing the complete privileged boundary and atomic
  updater generation. It preserves state and skips onboarding. After the
  boundary commits, every later release uses only `fased update` and ordinary
  updates must not repeatedly request authorization.
- A genuinely old Hosting installation without a root controller cannot let
  the unprivileged application replace root-owned services. It may require one
  verified provider-root bootstrap. The updater must detect this exact
  topology, preserve the installation, and print one complete transactional
  command. After that bootstrap, only `fased update` is used.
- Fresh installation and update are different transactions. Success of one
  never proves the other.
- Setup output is end-user output. Internal JSON, controller environments,
  download traces, timing internals, and duplicate dashboard URLs stay hidden
  unless verbose diagnostics are explicitly requested.

## One Engine, Platform Adapters

Local and Hosting use one lifecycle engine with platform adapters. They must
not evolve as independent installers.

The shared engine owns:

- release resolution and immutable identity;
- artifact verification, staging, and smoke checks;
- state inventory and schema migration;
- controller, signer, application, and dependency convergence;
- transactional activation, health, commit, and rollback;
- idempotent retry and final `Already current`.

Platform adapters own only:

- privilege acquisition;
- user and group identities;
- systemd or launchd service rendering and control;
- filesystem paths and operating-system credential storage;
- Hosting network hardening and Tailscale integration.

Platform adapters may not implement a second migration, wallet, signer, or
onboarding state machine.

## Stable Privileged Supervisor

Protected Local and Hosting place a stable, minimal supervisor below the
replaceable target lifecycle controller. The supervisor authenticates an exact
caller and a fixed operation allowlist, verifies immutable controller metadata
independently, enforces expiry, revocation, architecture, digest, and rollback
policy, atomically promotes or restores the controller, and returns a durable
redacted receipt.

It never accepts caller-supplied executables, arbitrary paths, shell fragments,
environment variables, URLs, service definitions, or ownership commands. It
never performs onboarding, Wallet, Mining, Network, provider, or application
configuration.

Fresh Protected Local and the one standard bootstrap from a recognized
pre-supervisor Local topology or incomplete legacy updater generation may
require one OS-native authorization ceremony to install this boundary. After
it commits, ordinary install completion, update, Doctor, restart, retry,
rollback, and migration do not request another administrator credential.
Explicit repair may request authorization only when the supervisor itself is
missing or irreparably damaged.

Fresh Hosting installs the boundary inside the one provider-root bootstrap.
The non-root Hosting `app` user subsequently runs `fased update`. A legacy
Hosting topology with no trusted privileged forward-update authority may
require one verified provider-root bootstrap; afterward only `fased update` is
used.

## Exclusive Phase Ownership

Exactly one component owns mutation in each phase:

| Component              | May do                                                                      | Must not do                                                                              |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Bootstrap installer    | acquire prerequisites, verify and enter the target controller               | migrate wallets, run onboarding, or become a second updater                              |
| Installed CLI/updater  | resolve, download, verify, stage, and hand off to the target controller     | mutate protected state or restart services after target authorization                    |
| Stable supervisor      | select, verify, promote, restore, and clean inactive controller generations | mutate application, Wallet, signer, Mining, Network, provider, or onboarding state       |
| Target root controller | reconcile privileged state, migrate, activate, verify, commit, or roll back | collect model-provider credentials or perform user onboarding                            |
| Go signer              | own keys, wallet policy, RPC/network identity, audit, and signing           | install services or mutate application-owned configuration                               |
| Gateway                | use granted application sockets and shared state                            | chown/chmod protected state, create setgid roots, or control privileged services         |
| Onboarding             | collect user configuration and invoke public wallet/provider operations     | install, migrate, repair, change service ownership, or restart the lifecycle transaction |
| Repair                 | restore a broken managed boundary with explicit operator intent             | serve as normal install/update acceptance or silently replace user state                 |

After the target controller accepts an update transaction, the installed old
updater becomes an observer. It may read the final receipt and report success
or failure. It must not perform a second restart, permission pass, commit, or
rollback. The target controller must handle supported older handoff messages
idempotently by protocol capability, not by hard-coded release names.

The stable supervisor is the sole writer of its controller release directory,
active controller pointer, controller identity, trust state, and inactive
historical-controller cleanup. A supervised target controller receives those
paths read-only. It verifies the supervisor-selected version and process
identity before product-state mutation and must not stage, promote, restore,
or delete a controller generation.

## Fresh Install State Machine

```text
detect empty or existing topology
-> resolve and verify the exact target
-> install or verify the platform privilege adapter
-> stage application, dependencies, controller, and signer
-> create canonical protected and shared state roots
-> start signer
-> start Gateway
-> verify exact identities, sockets, health, and state access
-> commit once
-> launch onboarding once
-> print one final dashboard URL once
```

A truly empty installation must not display “existing setup” or “review
settings.” If managed state already exists, the installer must delegate to the
existing-install/update decision instead of partially overlaying a fresh
install.

Failure before commit restores the complete prior topology or removes the
uncommitted fresh topology. Onboarding never starts before commit.

## Existing Update State Machine

```text
recover or roll back an interrupted transaction
-> resolve the selected target
-> verify and stage immutable artifacts while the old Gateway remains online
-> durably promote the verified target recovery controller
-> hand one transaction to that target controller
-> inventory state without changing user data
-> reconcile only declared state classes
-> migrate signer and application schemas transactionally
-> verify the supervisor-selected controller and atomically activate signer, application, and dependencies
-> perform one coordinated restart
-> run bounded health probes concurrently
-> target controller durably commits or restores product identities and last-success once
-> return the product result to the stable supervisor
-> stable supervisor commits or restores the controller and trust selection
-> return one final receipt to the installed updater
```

On failure, the target controller restores application, dependency, signer,
service, and last-success pointers plus the prior product service topology and
reports that durable result. Only the stable supervisor may then restore or
commit the controller pointer and trust selection. Neither process may clear
its journal until the corresponding result has been verified. A retry uses the
same `fased update` command. A successful final repeat is fast and reports
`Already current`.

User state must survive unchanged unless an explicit schema migration requires
a transactional representation change. Preserve at minimum:

- wallet IDs, handles, public addresses, roles, policies, grants, and RPCs;
- signer keys, audit history, approval state, and network identity;
- Mining history and SAT state;
- agents, providers, credentials, sessions, channels, plugins, and schedules;
- Gateway authentication and Local or Hosting access configuration.

## Shared State Contract

The target root controller creates and reconciles every protected shared root
before Gateway activation.

- owner-only state remains owner-readable only;
- signer-owned state remains inaccessible to Gateway except through the
  application socket;
- Gateway-shared directories have a declared group, setgid directory mode, and
  bounded writable file modes;
- Gateway may create ordinary children inside an already-authorized shared
  directory but may not set ownership, setgid, or privileged modes;
- reconciliation uses a fixed path whitelist, rejects symlinks, revalidates
  inode/path identity, and never recursively rewrites arbitrary user state.

Permissions are part of the transaction and health contract. A health check
must exercise identity, Wallet, Mining, signer diagnostics, plugin diagnostics,
and the real generated service restrictions—not merely test that a port opens.

## Onboarding State Machine

Onboarding begins only after the install or update transaction commits.

It owns:

- model-provider sign-in and user-selected integrations;
- Agent configuration;
- wallet creation/import through the typed Go signer client;
- wallet role, handle, RPC, routing, and optional policy/grant choices;
- final dashboard handoff.

It reads the same canonical provider registry, wallet registry, names, handles,
roles, and network state as the dashboard and CLI. It must not maintain a
parallel list or synthesize default wallet labels when real wallets exist.

Provider credentials follow the provider’s actual expiration and refresh
contract. Fased stores only the supported protected credential form; it must
not promise that every third-party session is permanent.

## Repair Boundary

Repair is a recovery entry point for a damaged or incomplete managed boundary.
It is not a normal migration plan and is never evidence that install or update
works.

Owner-machine candidate activation and Q0 are retired and must not exist in
product or development workflow. Isolated fixtures may invoke typed controller
operations only inside their disposable boundary. End users receive only the
documented installer, `fased update`, or the one narrowly required legacy
Hosting root bootstrap.

## Compatibility Model

Compatibility is selected by materially distinct topology, not every patch
release:

- empty installation;
- legacy unprotected Local;
- protected Local with an older updater/controller protocol;
- interrupted protected Local transaction;
- empty Hosting;
- legacy Hosting without a root controller;
- managed Hosting with an older updater/controller protocol;
- interrupted Hosting transaction;
- each supported platform adapter whose service or permission semantics differ.

Every supported installed topology must have either:

1. an ordinary same-command transactional update path; or
2. for pre-handoff Local, one documented standard Local bootstrap followed by
   ordinary updates; or
3. for the privilege-impossible legacy Hosting case, one documented, verified,
   transactional root bootstrap followed by ordinary updates.

An immutable old executable cannot be changed retroactively. Forward
compatibility belongs in the target controller and release assets.

Implementation status and remaining lifecycle work are tracked only in
[universal-install-update-plan.md](universal-install-update-plan.md). Test and
release order are owned only by [policy.md](policy.md) and
[test-selection.md](test-selection.md).
