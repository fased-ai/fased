---
name: fased-release-manager
description: Use for every task involving Fased, including status, diagnosis, focused fixes, lifecycle work, persistent approved plans, protected delivery, and explicitly requested releases. Automatically route through Sol Advisor orchestration without requiring the owner to name it.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or an explicitly selected worktree. Do not
scan parent directories, other worktrees, or archives unless requested.

## Start once

1. Invoke `sol-advisor:orchestration`; it selects route, role, delegation, and
   review. Default solo. Delegate only when it materially saves time.
2. Select the newest owner-chosen controlling plan and one mode. Print:
   `PLAN: <path or name> | MODE: <mode> | CHECKPOINT: <id> | STATUS: <status> | NEXT: <predicate>`
3. Preserve unrelated dirty work. Resume the plan's first incomplete checkpoint;
   superseded plans are evidence only.

The newest owner plan controls; superseded plans are evidence only.

- `REPORT`: inspect and answer without mutation.
- `FIX`: one failure, one correction, focused proof. Default mode.
- `LIFECYCLE`: installer, updater, privilege, service, or migration behavior.
- `RELEASE`: only after explicit candidate, publication, or stable authority.

Never allocate a version, build a candidate, or enter release mode to diagnose
a source, fixture, or user-visible failure.

## Soft budgets

- Load this file plus at most one reference; use at most six targeted discovery calls and a 6,000-token soft context budget.
- Every tool call must discover, edit, or verify; after discovery use at most twelve additional tool calls.
- Never repeat unchanged state. Explain commands over one minute and report every 60 seconds.

## Follow the plan before release

Release authority permits an irreversible action; it never proves readiness or
overrides the controlling plan. Before a release workflow, tag, publication,
promotion, or version-only change:

1. Read the controlling plan's ordered checkpoints.
2. Reconcile them with failures and unfinished branches/worktrees.
3. Identify the requested action's immediately preceding predicate.
4. Proceed only when that predicate and every earlier required predicate are
   `PASS` for the required commit, tree, artifact, receipt, and environment class.

Any `FAIL`, `BLOCKED`, `SUPPORTING`, stale receipt, or unclassified work keeps
the task in `FIX` or `LIFECYCLE`; only an explicit named `WAIVED` decision can
waive it. Never use a release to discover whether a correction works.

Continue until owner stop, identity/plan change, unavailable authority, or an
unnamed boundary. If same predicate failing twice, report it and block release.

If the owner defines `fix`, `continue`, or `finish` as a named chain, record it
once and run its push, PR, CI, merge, release, and publication as `PASS` gates
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

Never create a container, VM, disposable user/home, or simulated fresh install
for an ordinary correction. Use focused checks, then the affected existing owner
installation only when runtime proof is required. Substituted, non-interactive,
preseeded, container, or agent-created machines can never receive Local `PASS`.
Fresh Local is owner-run on an independent machine using the documented curl,
`fased status`, and `fased update`; accept literal owner output when unreachable.

For Hosting failures, inventory prerequisites, private network, generation,
readiness, onboarding, hardening, recovery, and identical retry before fixing.
Exercise adjacent durable transitions once; never publish first-error patches.

## Load details only when selected

- Tests, fixtures, protected delivery, workspace/cache hygiene:
  [references/tests.md](references/tests.md)
- Installer, updater, Local/Hosting, signer, service, state, or migration:
  [references/lifecycle.md](references/lifecycle.md)
- Fundamental lifecycle trust redesign, only when truly selected:
  [references/lifecycle-redesign.md](references/lifecycle-redesign.md)
- Explicit candidate, publication, or stable action:
  [references/release.md](references/release.md)

Docs/skills run their validator; workflows run static contracts; permission or
fixture changes run their exact regression. Avoid unrelated installs, builds,
containers, systemd, full suites, or CodeQL.

## Runtime and artifact discipline

Lead lifecycle reports with literal user commands and distinguish `documented`,
`implemented`, and `proven`. Managed users never maintain build tools, internal
paths, services, or journals.

Never rebuild Linux images for ordinary fixes. Reuse pinned fixture images and
cached artifacts. When distributable bytes change, build one cached unpublished
Linux-x64 artifact after focused tests, exercise only the affected topology, and
reuse those exact bytes. Fixture-only changes reuse prior verified product bytes.

Candidate and release work begins only after the literal affected-environment
command passes. One protected release workflow derives the next signed channel
sequence, builds one Linux-x64 artifact after source is final, attests it, creates
the immutable tag, publishes those bytes, and advances the channel. The
publication must verify receipts and must not rebuild or replay product
execution. A partial public-release retry uses only metadata. Broad Node, Go,
Docker, CodeQL, multi-platform, and dead-code matrices are weekly/manual
diagnostics, not ordinary-PR or release acceptance gates.

When Hosting product bytes change, a root container is H0 `SUPPORTING` evidence
only. Before candidate allocation, require one owner-authorized real-init
staging VM/VPS run using the exact unpublished artifact, real package manager,
systemd and the intended resource floor. After publication, only the literal
immutable public installer on an authorized VPS plus an identical-command
`Already current` result can mark real Hosting `PASS`. A waiver never changes
either rule.

## Evidence and authority

Use only `PASS`, `FAIL`, `BLOCKED`, `SUPPORTING`, `WAIVED`, and `N/A`. Source,
mock, fixture, container, or substituted transport evidence never becomes
owner-Local, real-Hosting, or public `PASS`. Bind completion claims to the exact
identity required by the selected reference.

Managed publication is GitHub-only; npm is never managed install/update
authority. Never bypass protected checks. Repository/full security scans require
owner authorization.

## Branch and workspace discipline

- Prefer one owner workspace, `main`, and one task branch/worktree. Preserve any
  unique inactive work in a verified bundle; remove the task worktree, branch
  and tracking ref only after exact merged-tree validation.
- Cache immutable artifacts/tools/one predecessor, never installations,
  journals, Wallets or signer state. Use `$XDG_CACHE_HOME/fased-dev` and exact
  task-created `/tmp/fased-*` directories; remove only classified residues.
- Check `sudo -n true` once when privilege is selected. If unavailable, report
  `NOT RUN: sudo credential expired`; never poll.

The canonical skill is
`docs/maintainers/codex-skills/fased-release-manager/`. Synchronize the installed
copy only after the canonical folder and harness validator pass.
