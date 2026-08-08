# Universal Fased Install and Update Convergence

Status: **ACTIVE IMPLEMENTATION PLAN — NOT RELEASE EVIDENCE**

This version-neutral plan tracks the remaining product work. It does not select
tests, authorize a release, or store live gate state. Ordinary PR and candidate
rules are owned by [policy.md](policy.md), [test-selection.md](test-selection.md),
and [release-flow.md](release-flow.md). Product behavior is owned by
[lifecycle-architecture.md](lifecycle-architecture.md).

Concrete versions, commits, artifacts, machines, and outcomes belong in GitHub
runs, immutable candidate manifests, and acceptance records.

## End-user contract

```text
Fresh Local       -> documented Local installer
Fresh Hosting     -> documented Hosting installer
Managed Local     -> fased update
Managed Hosting   -> fased update
Damaged boundary  -> explicit verified repair -> fased update thereafter
```

Fresh install, update, and repair must converge on the same canonical topology.
Local and Hosting share one transaction engine and differ only through platform
adapters.

## Compatibility contract

Compatibility is selected by installation-manifest schema, persisted-state
schema, topology, platform adapter, and protocol capability—not by every
release string.

- Every candidate proves latest supported public stable to candidate.
- Add an older predecessor fixture only for a materially distinct public
  schema/topology/capability that remains supported.
- Unknown newer schemas and incompatible protocol ranges fail without mutation.
- Interrupted supported migrations roll back exactly and the same command
  retries idempotently.
- Mixed private prerelease residue is not a production compatibility class. It
  uses one owner-authorized repair into the canonical topology.

## Target architecture

```text
fased update
  -> resolve and verify one immutable target
  -> acquire one exclusive update lock
  -> read one canonical installation manifest
  -> choose one explicit migration plan
  -> snapshot declared state digests
  -> execute one logical transaction
       supervisor journal: controller trust/select/commit-or-restore
       target journal: product stage/migrate/health/commit-or-restore
       both bind the same transaction, candidate, artifacts, capabilities,
       previous generation, and rollback pointers
  -> Local adapter or Hosting adapter
  -> read back exact health and identity
  -> report Updated, Already current, Rolled back safely, or Repair required
```

The shared engine owns target verification, migration selection, state
inventory, activation, health, commit, rollback, retry, and idempotence. The
stable supervisor exclusively owns controller trust and generation selection;
the target controller exclusively owns product, signer, application,
dependency, and service mutation. Their authority-scoped journals share one
transaction envelope but never make competing recovery decisions. Adapters own
privilege acquisition, users/groups, paths, service rendering and control,
credential storage, and Hosting network hardening only.

## Durable state

Use separate immutable identities:

- `SourceIdentity`: commit, tree, lockfile, classifier/plan digest.
- `CandidateIdentity`: version, artifact-set digest, provenance, build run.
- `InstallationIdentity`: profile, active/previous generation, schemas,
  capabilities, and service identities.
- `AcceptanceIdentity`: candidate, profile/machine, and before/after state
  digests.

Control state consists of one installation manifest, one active transaction
journal, current/previous committed generation pointers, receipts keyed by
transaction ID, and schema/capability versions.

Preserve independently:

- Wallet registry and policy;
- signer database, master key, audit and network identity;
- Mining ledger and SAT state;
- agents, providers, credentials, sessions, channels and schedules;
- Gateway authentication, configuration, plugins, and Local/Hosting access.

Replaceable control state includes application runtime, updater, controller,
supervisor, generated units, caches, staging, and bounded old receipts.

## Work packages

### U1 — establish one ownership boundary

- Freeze new legacy/adoption behavior.
- Define canonical identities, manifest, journal, engine, and adapter contracts.
- Route fresh and supported-stable operations through the shared engine.
- Keep ambiguous installations on the explicit non-mutating repair result.

### U2 — prove and cut over

- Merge the focused source correction through stateless PR CI.
- Build one candidate once in the protected candidate workflow.
- Run packaged P1 once against the exact bytes: fresh protected Local,
  supported stable update, injected failure, rollback/retry, restart,
  preservation, and `Already current`.
- Publish those bytes as a GitHub prerelease, complete owner npm beta and
  PUBLIC0, then perform literal owner Local acceptance.
- Run real Hosting acceptance before stable promotion.

### U3 — remove superseded implementations

- Inventory remaining legacy/adoption branches by public contract protected.
- Delete private-prerelease-only adoption paths, journals, acknowledgements,
  normalizers, and tests after owner repair and the public stable bridge pass.
- Re-run the same fresh/install/update acceptance against the reduced engine.

## Product evidence

Ordinary PR:

```text
exact symptom -> narrow regression -> correction -> focused checks
-> optional root-capable T2 -> focused PR -> protected merge
```

Candidate P1 covers only durable release contracts:

- fresh protected Local install;
- latest supported public stable to candidate;
- one materially distinct older public schema only when still supported;
- injected failure with exact rollback and same-command retry;
- restart/reboot health and declared-state preservation; and
- repeated command returning `Already current`.

Real Hosting runs at the candidate/stable boundary on an authorized VPS with
the intended Tailscale policy. Containers are supporting fixtures, not H1/H2.

## Operational invariants

- Preflight artifact identity, architecture, signatures/provenance, schemas,
  capabilities, rollback floor, lock ownership, and disk space before mutation.
- Keep the old Gateway serving through staging and smoke checks.
- Every wait has a named timeout and prints its first failed predicate.
- Exactly one component writes each journal phase under one transaction ID.
- Activation changes only staged atomic selectors; retain active and one prior
  verified generation.
- Rollback restores selectors, services, compatibility, and last-success
  identity before reporting completion.
- Normal output is bounded to `Updated`, `Already current`, `Rolled back
safely`, or `Repair required`, with stable machine-readable exit codes.

## Reduction budgets

These are maintainability guardrails, not permission to weaken security:

- acquisition/installer wrapper: approximately 500 lines;
- shared transaction engine: approximately 3,000 lines;
- each platform adapter: approximately 1,000 lines;
- identity/manifest/journal/migration contracts: approximately 2,000 lines;
- active central lifecycle implementation: approximately 8,000–12,000 lines;
- zero production conditions keyed to private prerelease versions; and
- one control-plane mutation owner and one product transaction owner at a time.

Use a strangler cutover: preserve current black-box acceptance, route one
operation at a time to the shared engine, never dual-write, and delete the old
owner immediately after the replacement path passes.

## Completion criteria

This plan is complete only when:

- fresh Local and supported stable update converge on one topology;
- one manifest, logical transaction, shared engine, two bound authority-scoped
  journals, and one Local/Hosting adapter set own updates;
- unknown-newer state fails unchanged;
- interruption rolls back, retries, restarts, preserves declared state, and
  becomes `Already current`;
- damaged private residue is repaired once without entering ordinary updater
  logic;
- real Hosting acceptance passes before stable; and
- obsolete private-prerelease adoption code is deleted.
