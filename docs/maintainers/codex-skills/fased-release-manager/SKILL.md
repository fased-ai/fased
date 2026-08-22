---
name: fased-release-manager
description: Use for every task involving Fased, including status, diagnosis, focused fixes, lifecycle work, persistent approved plans, protected delivery, and explicitly requested releases. Automatically route through Sol Advisor orchestration without requiring the owner to name it.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or one explicitly selected Fased
worktree. Never scan the parent, all worktrees, or archived incidents unless the
owner requests that inventory.

## Start once

1. Invoke `sol-advisor:orchestration`; it selects route, role, delegation, and
   review. Default solo. Delegate only when it materially saves time.
2. Select the newest owner-chosen controlling plan and one mode. Print:
   `PLAN: <path or name> | MODE: <mode> | CHECKPOINT: <id> | STATUS: <status> | NEXT: <predicate>`
3. Preserve unrelated dirty work. Resume the plan's first incomplete checkpoint;
   superseded plans are evidence only.

The newest owner-selected plan controls until replaced or completed;
superseded plans are evidence only. At handoff, name and continue its first
incomplete checkpoint.

- `REPORT`: inspect and answer without mutation.
- `FIX`: one failure, one correction, focused proof. Default mode.
- `LIFECYCLE`: installer, updater, privilege, service, or migration behavior.
- `RELEASE`: only after explicit candidate, publication, or stable authority.

Never allocate a version, build a candidate, or enter release mode to diagnose
a source, fixture, or user-visible failure.

## Soft budgets

- Before the first edit, normally use at most six targeted discovery calls.
  Batch independent reads and name the first failing predicate.
- Keep task-specific instructions and references near a 6,000-token soft
  context budget.
- Load this file plus at most one reference for ordinary work. Load a second
  only after reporting the unresolved predicate requiring it.
- Every tool call must discover, edit, or verify the selected predicate. Never
  poll unchanged state or repeat an unchanged command.
- After discovery, target at most twelve additional tool calls for one bounded
  correction.
- These are soft limits. Exceed one only with a one-line reason; never omit
  safety or correctness evidence to meet a budget. Do not set a hard token
  budget unless the owner explicitly requests one.
- Explain commands expected to exceed one minute. A diagnostic cycle should
  normally finish within 15 minutes; report progress at least every 60 seconds.

## Follow the plan before release

Release authority permits an irreversible action; it never proves readiness or
overrides the controlling plan. Before PRE-CANDIDATE, RC allocation, P1, tag,
publication, promotion, or version-only change:

1. Read the controlling plan's ordered checkpoints.
2. Reconcile them with current failures and unfinished branches/worktrees.
3. Identify the requested action's immediately preceding predicate.
4. Proceed only when that predicate and every earlier required predicate are
   `PASS` for the required commit, tree, artifact, receipt, and environment class.

Any required `FAIL`, `BLOCKED`, `SUPPORTING`, stale receipt, or unclassified
implementation keeps the task in `FIX` or `LIFECYCLE`. Only an explicit named
`WAIVED` risk decision can waive a predicate. Never use a new RC, tag, or publication to discover
whether a correction works, and never present release progress as completion
of later architecture phases.

Continue until owner stop, identity/plan change, unavailable authority, or an
unnamed boundary. Bare `fix` uses the narrow flow below; never inventory a whole
subsystem without evidence. If same predicate failing twice or evidence couples
adjacent owners, name only those predicates; block another candidate until they
pass.

If the owner defines `fix`, `continue`, or `finish` as a named chain, record it
once and run its push, PR, CI, merge, P1, tag, and publication as `PASS` gates
without asking again; this survives compaction until done or revoked. Unlisted
owner/Hosting mutation, promotion, npm, cleanup, and deployment stay out.

## Fix the literal predicate first

For every Fased issue, default to:

1. Preserve and inspect that exact environment and command.
2. Identify the first divergent predicate.
3. Add the nearest red-capable regression when needed.
4. Make one coherent correction.
5. Run that test, directly coupled contracts, and changed-file formatting.
6. Report or continue the active plan.

`reproduce -> focused regression -> fix -> focused test -> one literal runtime proof when required -> one PR/CI -> merge`

Until the predicate passes, do not divert into full suites, broad scans, CI,
candidates, publication, or release planning. Never run GitHub CI while
diagnosing. `fix and ship` means one locally proven final diff, one push, one
protected PR, one changed-surface CI result, and an authorized exact-head squash
merge.

## Load details only when selected

- Tests, fixtures, protected delivery, workspace/cache hygiene:
  [references/tests.md](references/tests.md)
- Installer, updater, Local/Hosting, signer, service, state, or migration:
  [references/lifecycle.md](references/lifecycle.md)
- Fundamental lifecycle trust redesign, only when truly selected:
  [references/lifecycle-redesign.md](references/lifecycle-redesign.md)
- Explicit candidate, publication, or stable action:
  [references/release.md](references/release.md)

Docs and skills run only their validator. Workflow changes run static contracts.
Permission or fixture changes run their exact regression. Do not run dependency
installs, containers, systemd, full suites, CodeQL, or builds unless the changed
surface requires them.

## Runtime and artifact discipline

Lead lifecycle reports with literal user commands and distinguish `documented`,
`implemented`, and `proven`. Managed users never maintain build tools, internal
paths, services, or journals.

Never rebuild Linux images for ordinary fixes. Reuse pinned fixture images and
cached artifacts. When distributable bytes change, build one cached unpublished
Linux-x64 artifact after focused tests, exercise only the affected topology, and
reuse those exact bytes. Fixture-only changes reuse prior verified product bytes.

Candidate and release work begins only after the literal end-user command
passes. Reuse identical bytes across acceptance, P1, tag, and publication;
publication must not rebuild. Full `LOCAL0`, PRE-CANDIDATE, P1, tag, and
publication belong only to an explicit release plan.

## Evidence and authority

Use only `PASS`, `FAIL`, `BLOCKED`, `SUPPORTING`, `WAIVED`, and `N/A`. Source,
mock, fixture, container, or substituted transport evidence never becomes
owner-Local, real-Hosting, or public `PASS`. Bind completion claims to the exact
identity required by the selected reference.

Managed publication is GitHub-only; npm is never managed install/update
authority. Never bypass protected checks. Repository/full security scans require
owner authorization.

## Branch and workspace discipline

- Prefer one owner workspace and one current-main task worktree. Use another
  only for a real conflict or intentionally preserved evidence.
- Budget local branches to `main` plus one active task branch. Preserve unique
  inactive work in one verified bundle with an exact restore command.
- Record task-branch deletion as `remove after exact merged-tree validation` and
  remove its worktree, local branch, and tracking ref when proven.
- Cache immutable artifacts, dependencies, toolchains, fixture images, and one
  predecessor set; never cache installations, journals, Wallets, or signer state.
- Use `${XDG_CACHE_HOME:-$HOME/.cache}/fased-dev` and `mktemp -d
/tmp/fased-<task>.XXXXXX`; remove only task-created residues.
- Check `sudo -n true` once when privilege is selected. If unavailable, report
  `NOT RUN: sudo credential expired`; never poll.

The canonical skill is
`docs/maintainers/codex-skills/fased-release-manager/`. Synchronize the installed
copy only after the canonical folder and harness validator pass.
