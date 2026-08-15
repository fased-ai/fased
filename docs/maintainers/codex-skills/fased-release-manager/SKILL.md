---
name: fased-release-manager
description: Manage persistent approved Fased plans, focused fixes, protected delivery, and explicitly requested releases without losing the active checkpoint or expanding its scope.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or one explicitly selected Fased
worktree. Never scan the whole parent directory, every worktree, or archived
incidents.

## Controlling plan and continuation

Select exactly one controlling plan for multi-checkpoint work. At the start and
after every material status change, print one compact banner:

`PLAN: <path or named plan> | MODE: <mode> | CHECKPOINT: <id> | STATUS: <status> | NEXT: <predicate>`

An explicitly selected or owner-approved plan remains active until it is
complete, genuinely blocked, replaced by the owner, or stopped by the owner.
`Do it`, `continue`, `next`, and `finish the plan` resume that plan at its first
incomplete predicate. They are not unrelated new tasks and do not discard prior
in-scope authorization. They also do not expand the plan.

After a checkpoint passes, continue automatically through the next reversible,
already-authorized checkpoint. Do not stop merely to announce a pass or request
permission for ordinary local edits, focused tests, cached branch artifacts,
PR creation, or monitoring an existing protected check. Keep progress visible.

Stop only when:

- the plan is complete;
- the user says stop or replaces it;
- the first failed predicate requires a plan amendment or authority expansion;
- the same predicate fails twice after one coherent correction;
- required external state or credentials are unavailable; or
- an irreversible boundary is not covered by recorded current authorization.

Irreversible boundaries are merge, tag, GitHub publication, owner installation,
real Hosting mutation, and stable promotion. If the owner
explicitly authorizes a named sequence through one or more boundaries, record
`AUTHORIZED THROUGH: <boundary>` and do not ask again while the exact plan and
artifact identity remain unchanged.

A genuinely unrelated newer request replaces active work. A bare continuation
message does not. Never silently switch plans, checkpoints, repositories,
installation classes, or artifact identities.

## Scope and mode

Choose one mode:

- `REPORT`: inspect and answer; no mutation or resumed work.
- `FIX`: smallest correction and focused validation; this is the default.
- `LIFECYCLE`: only when installer/updater privileged product behavior changes.
- `RELEASE`: only for an explicitly requested candidate, publication, or stable
  action.

Advance modes only when the controlling plan or newest request explicitly
contains that transition and every preceding exit predicate is satisfied.

If a newer request replaces active work, stop the obsolete command safely and
switch scope. In a dirty worktree, preserve unrelated changes and isolate the
requested patch before editing or committing.

## FIX

1. Use the nearest red-capable test when a test is needed.
2. Make one coherent correction.
3. Run that test, directly coupled contracts, and changed-file formatting.
4. Report the result. For a standalone fix, hand back; inside an active
   controlling plan, continue to its next reversible checkpoint.

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
during development. For standalone lifecycle work, hand back after local
closure unless shipping was requested. Inside an active controlling plan,
continue according to that plan's declared checkpoints and recorded authority.

For a root lifecycle, installer trust, Local/Hosting convergence, or updater
architecture replacement, also read
[`references/lifecycle-redesign.md`](references/lifecycle-redesign.md). Follow
its numbered checkpoint only; never skip from red contracts to a product build,
PR, or candidate. A locked user-supplied incident plan is controlling when it
is stricter.

For lifecycle design or status, lead with the literal end-user commands and
separate `documented`, `implemented`, and `proven`. Do not tell managed users
to maintain Node, npm, pnpm, Git, Go, GitHub CLI, internal paths, services, or
migrations. Do not claim universal install/update until every selected
acceptance ID has an exact enforcing receipt.

## RELEASE

Read [`references/release.md`](references/release.md). A candidate confirms
already-passing predicates against immutable final bytes; it never diagnoses
source. Build once, run independent P1 lanes in parallel, and never rebuild
between P1 and publication.

Version identity is strict, but version never selects product behavior. Before
allocating a candidate, bind the supported installation classes by profile,
topology, canonical manifest schema, platform identity, state-schema digest,
capability digest, and active-generation protocol. Use concrete predecessor
versions only to materialize those classes in evidence. Never create a P1 lane,
product branch, or deferred tagged transition merely because the owner's
machine runs a different RC. Candidate P1 replays every materially distinct
supported installation class in parallel against the same exact bytes.
A synthetic or sanitized predecessor is `SUPPORTING` unless its complete
semantic installation class matches the required predecessor receipt. A
candidate whose tagged source is followed by any product correction is
permanently obsolete: never move its tag, rebuild it, publish replacement bytes
under its version, or use it for owner acceptance.

No tag may allocate an ordinary product predicate for the first time. Before
requesting tag authority, run every supported Local and Hosting topology whose
trust inputs can exist pre-tag, using the same fixture entrypoints, mount
topology, acquisition routes, candidate-shaped inventory, and acceptance
receipt verifier that trusted P1 will run. A predecessor that cannot enter the
static Go control plane through its installed updater is not automatically
`REPAIR_REQUIRED`. When its healthy topology is recognized and its immutable
inputs verify, run the documented installer once as an in-place takeover, then
prove the installed `fased update` returns `Already current`. Reserve
`REPAIR_REQUIRED` for ambiguous, damaged, or incompatible state. Never preserve
an application-owned root updater or invent a release-specific exception.

If a tagged run exposes a fixture or inventory predicate that could have
executed before the tag, freeze the release. Correct the workflow first and add
that predicate to pre-tag closure. Do not allocate another tag until the
corrected pre-tag run passes.

An unpublished branch artifact built after a published tag is development
evidence bound to its commit, tree, and artifact digest. Always call it a
`corrected branch artifact`; never describe it as the published RC whose
package version it inherits.

## Speed and authority

- Never duplicate a running command or rerun an unchanged failure.
- Correct and rerun only the first failed predicate. Stop after it fails twice.
- Treat a workflow timeout as an emergency ceiling, never as the expected wait.
  Before starting a long proof, name each phase, its independently observed
  progress signal, and the shortest inactivity budget justified by a passing
  cold-run baseline. Diagnostic branch proofs should normally finish within 15
  minutes; any longer ceiling or any inactivity budget above 120 seconds needs
  a recorded baseline and explicit reason.
- Run one same-runner proof only after focused local and protected PR checks pass,
  and only once per materially changed source commit. On failure, preserve and
  inspect its receipt immediately before editing. Never increase a timer or
  restart a quiet job without new causal evidence.
- Release archives use separately bounded raw-tar and gzip phases in one private
  transaction directory. Close, verify, and fsync raw tar before compression;
  close, verify, and fsync gzip before no-clobber publication. A byte counter
  upstream of a backpressured transform is not independent liveness evidence.
- Archive receipts must report the validated manifest count, completed count,
  active path/type/declared size, active-entry bytes, and destination bytes.
  Publish the small receipt and log on failure; never retain or upload the
  unpublished candidate-shaped archive merely to diagnose it.
- Cache immutable artifacts, toolchains, dependencies, images, and predecessor
  assets—not installations, journals, Wallets, or signer state.
- Explain any command expected to exceed one minute before starting it.
- Do not inspect GitHub until reviewing or shipping.
- Never bypass protection. Tags, releases, owner installations, Hosting,
  and stable promotion require current explicit authority.

## Workspace hygiene

- Never create a cache or temporary root directly under `/home/fc/fasedbot`,
  set that path as `HOME`, or point `TMPDIR`, `GOCACHE`, `GOTMPDIR`, receipts,
  or artifact output into it.
- Prohibited direct children include `.gc`, `.go-build-cache`, `.go-cache-*`,
  `.npm-cache`, `.test-tmp`, `fu`, `t`, `artifact-*`, `hosted-artifacts*`,
  `npm-smoke-*`, `release-evidence`, `release-validation-*`, and owner-repair
  scratch-code directories. Never use a shorter workspace-local alias merely
  to bypass this list.
- Use `${XDG_CACHE_HOME:-$HOME/.cache}/fased-dev` as the only persistent
  development cache and one shared `go-build` subdirectory. Key reusable
  artifacts by immutable commit, tree, lockfile, and artifact digests.
- Create transient directories with `mktemp -d /tmp/fased-<task>.XXXXXX` and
  register `EXIT`, `INT`, and `TERM` cleanup before performing work.
- Persist JSON receipts only. Never retain fixture installations, Wallets,
  signer state, journals, logs, or extracted runtimes as evidence.
- Retain the current branch artifact, one immutable predecessor set, and active
  staging only. Remove failed/interrupted staging automatically. Enforce a
  10 GiB cache budget and seven-day TTL.
- Treat `/home/fc/fasedbot/.tmp` as shared mixed-project state. Never delete it
  wholesale; audit and remove only exact owner-authorized children.
- Before starting and before handoff, compare the workspace's direct children.
  Remove every cache, artifact, fixture, or temporary root created by the task
  before reporting completion. Never automatically delete a disabled Git
  database, durable owner-state backup, Wallet/signer material, or unarchived
  security finding; classify and obtain exact authority first.

Managed release publication is GitHub-only. Never publish npm packages or use
registry tags as candidate, acceptance, or stable-promotion evidence.

Load at most one reference for ordinary work. The canonical skill is
`docs/maintainers/codex-skills/fased-release-manager/`; synchronize the
installed copy only from a validated canonical package.
