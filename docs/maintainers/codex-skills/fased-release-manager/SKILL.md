---
name: fased-release-manager
description: Manage focused Fased fixes, protected delivery, and explicitly requested releases without expanding small tasks into lifecycle or release work.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or one explicitly selected Fased
worktree. Never scan the whole parent directory, every worktree, or archived
incidents.

## Scope first

The newest request is the scope ceiling. Older plans and approvals are inactive
unless the user explicitly resumes a named phase. `Do it`, `continue`, and
`finish` apply only to the newest request.

Choose one mode:

- `REPORT`: inspect and answer; no mutation or resumed work.
- `FIX`: smallest correction and focused validation; this is the default.
- `LIFECYCLE`: only when installer/updater privileged product behavior changes.
- `RELEASE`: only for an explicitly requested candidate, publication, or stable
  action.

Never advance to the next mode automatically.

If a newer request replaces active work, stop the obsolete command safely and
switch scope. In a dirty worktree, preserve unrelated changes and isolate the
requested patch before editing or committing.

## FIX

1. Use the nearest red-capable test when a test is needed.
2. Make one coherent correction.
3. Run that test, directly coupled contracts, and changed-file formatting.
4. Stop and report.

Close focused source predicates before building any artifact. A validator
PASS proves structure only; never report it as product-behavior proof.

Docs and skills run only their validator. Workflow changes run static workflow
contracts. Permission and fixture changes run only their focused regression.
Do not run builds, dependency installation, containers, systemd, full suites,
CodeQL, PRE-CANDIDATE, P1, PRs, or releases unless the current request and
changed product bytes require them.

`fix and ship` adds one protected PR after local closure. Read
[`references/tests.md`](references/tests.md) only when selecting tests or CI.

## LIFECYCLE

Read [`references/lifecycle.md`](references/lifecycle.md). Run affected unit
tests first. If product runtime bytes changed, build one cached unpublished
Linux-x64 artifact bound to commit, tree, and lockfile digest; exercise only the
affected topology against those exact bytes. Reuse it for rollback, restart,
preservation, and `Already current`. Never build ARM/macOS or a release matrix
during development. Stop after local closure unless shipping was requested.

For a root lifecycle, installer trust, Local/Hosting convergence, or updater
architecture replacement, also read
[`references/lifecycle-redesign.md`](references/lifecycle-redesign.md). Follow
its numbered checkpoint only; never skip from red contracts to a product build,
PR, or candidate. A locked user-supplied incident plan is controlling when it
is stricter.

## RELEASE

Read [`references/release.md`](references/release.md). A candidate confirms
already-passing predicates against immutable final bytes; it never diagnoses
source. Build once, run independent P1 lanes in parallel, and never rebuild
between P1 and publication.

Version identity is strict. Before allocating a candidate, bind both the latest
supported stable predecessor and the actual owner Local predecessor into
PRE-CANDIDATE evidence. Prove both locally against the branch artifact when
they differ. Candidate P1 replays both in parallel against the same exact
bytes. A candidate whose tagged source is followed by any product correction
is permanently obsolete: never move its tag, rebuild it, publish replacement
bytes under its version, or use it for owner acceptance.

No tag may allocate a predicate for the first time. Before requesting tag
authority, run the same Local and Hosting fixture entrypoints, mount topology,
public-acquisition routes, candidate-shaped inventory, predecessor scenarios,
and acceptance receipt verifier that trusted P1 will run. This pre-tag closure
must execute on the protected Linux runner, not only as local text assertions.
Production signatures and supported-architecture packaging may remain release
operations; fixture wiring, artifact names, lifecycle behavior, and every P1
acceptance predicate may not.

If a tagged run exposes a fixture or inventory predicate that did not execute
before the tag, freeze the release. Correct the workflow first and add that
predicate to pre-tag closure. Do not allocate another tag until the corrected
pre-tag run passes.

An unpublished branch artifact built after a published tag is development
evidence bound to its commit, tree, and artifact digest. Always call it a
`corrected branch artifact`; never describe it as the published RC whose
package version it inherits.

## Speed and authority

- Never duplicate a running command or rerun an unchanged failure.
- Correct and rerun only the first failed predicate. Stop after it fails twice.
- Cache immutable artifacts, toolchains, dependencies, images, and predecessor
  assets—not installations, journals, Wallets, or signer state.
- Explain any command expected to exceed one minute before starting it.
- Do not inspect GitHub until reviewing or shipping.
- Never bypass protection. Tags, releases, npm, owner installations, Hosting,
  and stable promotion require current explicit authority.

For npm, print only:

`npm publish <path> --ignore-scripts --access public --tag beta`

Never request, print, store, or pass an OTP or token.

Load at most one reference for ordinary work. The canonical skill is
`docs/maintainers/codex-skills/fased-release-manager/`; synchronize the
installed copy only from a validated canonical package.
