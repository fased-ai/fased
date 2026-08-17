---
name: fased-release-manager
description: Use for every task involving Fased, including status, diagnosis, focused fixes, lifecycle work, persistent approved plans, protected delivery, and explicitly requested releases. Automatically route through Sol Advisor orchestration without requiring the owner to name it.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or one explicitly selected Fased
worktree. Never scan the parent directory, every worktree, or archived incidents
unless the owner explicitly asks for that inventory.

## Start once

1. Invoke `sol-advisor:orchestration` before task tools. It exclusively selects
   the primary prerequisite, route, role, model, effort, delegation, and review.
2. Default to `solo`. Do not add an auxiliary or fresh review merely because the
   task mentions lifecycle, security, or release work.
3. Select one controlling plan and one mode. Print:

   `PLAN: <path or name> | MODE: <mode> | CHECKPOINT: <id> | STATUS: <status> | NEXT: <predicate>`

4. Preserve unrelated dirty work and isolate the requested change.

Use one mode:

- `REPORT`: inspect and answer; make no mutation.
- `FIX`: one failure, one correction, focused proof. This is the default.
- `LIFECYCLE`: installer, updater, privilege, service, or migration behavior.
- `RELEASE`: only after explicit candidate, publication, or stable authority.

Do not allocate a version, build a candidate, or enter release mode to diagnose
a source or fixture failure.

## Continue without loops

An owner-approved plan stays active until complete, replaced, stopped, blocked,
or failed. `Do`, `continue`, `next`, and `finish` resume its first incomplete
predicate; they do not restart it or widen authority.

Continue automatically through reversible authorized checkpoints. Stop only
for completion, owner stop/replacement, one failed predicate requiring a plan
change, the same predicate failing twice, unavailable external authority, or an
uncovered irreversible boundary.

Irreversible boundaries are merge, tag, GitHub publication, owner installation,
real Hosting mutation, and stable promotion. Record multi-boundary authority and
do not ask again while the exact plan and artifact identity remain unchanged.

Never duplicate a running command, rerun an unchanged failure, restart quiet CI,
or rebuild unchanged bytes.

Treat every created branch and worktree as owned plan state. At start and
handoff, classify it as active, exact-merged, or preserved with its origin,
blocker, and next action. Never silently abandon it. Preservation is not
completion: resume, split, or obtain owner authority to discard it.

## Fix the user-visible predicate first

For a reported install, update, repair, uninstall, onboarding, command, or
runtime failure:

1. Preserve and inspect that exact environment and command.
2. Identify the first divergent predicate.
3. Add the nearest red-capable regression when needed.
4. Make one coherent correction.
5. Run that test, directly coupled contracts, and changed-file formatting.
6. Report or continue the active plan.

Until that predicate passes, do not divert into broad status work, worktree
reconciliation, full suites, whole-repository security scans, CI, candidates,
publication, or release planning. Separate an expected privilege prompt,
slow-but-live progress, and product failure.

For tests or protected delivery, read [references/tests.md](references/tests.md)
and no unrelated reference. Docs and skills run only their validator. Workflow
changes run static contracts. Permission or fixture changes run only their
focused regression. Do not run dependency installs, containers, systemd, full
suites, CodeQL, or builds unless the changed product surface requires them.

`fix and ship` means focused local closure, one push, one protected PR, one
changed-surface CI result, and an authorized exact-head squash merge.

## Load details only when selected

- For installer, updater, Local/Hosting, signer, service, state, or migration
  behavior, read [references/lifecycle.md](references/lifecycle.md).
- For a fundamental installer/updater trust or lifecycle architecture
  replacement, additionally read
  [references/lifecycle-redesign.md](references/lifecycle-redesign.md).
- After explicit candidate, publication, or stable authority, read
  [references/release.md](references/release.md).

Load at most one reference for ordinary work. A stricter owner-approved incident
plan controls its declared scope.

For lifecycle reports, lead with literal end-user commands and distinguish
`documented`, `implemented`, and `proven`. Managed users never maintain Node,
npm, pnpm, Git, Go, GitHub CLI, internal paths, services, or journals.

When lifecycle product bytes change, run focused tests first, build one cached
unpublished Linux-x64 artifact, exercise only affected topology, and reuse exact
bytes. Fixture-only changes reuse verified prior product bytes. Full `LOCAL0`,
PRE-CANDIDATE, P1, tags, and publication belong only to an explicitly selected
release plan.

## Evidence and authority

Use only `PASS`, `FAIL`, `BLOCKED`, `SUPPORTING`, `WAIVED`, and `N/A`.
Supporting source, mock, fixture, container, or substituted transport evidence
never becomes public, owner-Local, or real-Hosting `PASS`.

Do not claim completion from source, CI, an artifact, a candidate number, or
publication alone. Bind claims to exact commit/tree/artifact/receipt identity
required by the selected reference.

Managed publication is GitHub-only. Never publish npm packages or use npm tags
as managed install, update, candidate, or acceptance authority. Never bypass
protected checks. Do not inspect GitHub until reviewing or shipping.

Whole-repository or full security scans require explicit owner authorization.
Run only a focused changed-surface security check when selected by the task or
protected PR policy.

## Speed and workspace

- Prefer one owner workspace and one current-main development worktree. Create
  temporary worktrees only for conflicting preserved work or exact evidence.
- Reuse the active issue branch across its checkpoints. After exact merged-tree
  proof, return the owner workspace to `main` and remove the task worktree and
  local issue branch. Never create one branch or worktree per agent or test.
- Cache immutable artifacts, dependencies, toolchains, fixture images, and one
  predecessor set; never cache installations, journals, Wallets, or signer state.
- Use `${XDG_CACHE_HOME:-$HOME/.cache}/fased-dev`; never create cache, artifact,
  receipt, `HOME`, `TMPDIR`, or Go-cache roots directly under
  `/home/fc/fasedbot`.
- Create transient roots with `mktemp -d /tmp/fased-<task>.XXXXXX` and register
  cleanup for exit and signals.
- Persist small JSON receipts only. Remove task-created staging and temporary
  roots before handoff; never delete owner data, secrets, backups, or unarchived
  findings automatically.
- Explain any command expected to exceed one minute. Diagnostic proofs should
  normally finish within 15 minutes; any inactivity budget above 120 seconds
  requires a passing baseline and explicit reason.
- Check `sudo -n true` once when privilege is selected. If unavailable, report
  `NOT RUN: sudo credential expired`; never poll.

The canonical skill lives at
`docs/maintainers/codex-skills/fased-release-manager/`. Synchronize the installed
copy only after the canonical folder passes its validator.
