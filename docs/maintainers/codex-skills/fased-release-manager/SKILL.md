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
- `RELEASE`: when the owner explicitly says to release, publish, or create the
  next tag.

Use `FIX` or `LIFECYCLE` to close the reported failure before entering
`RELEASE`.

## Soft budgets

- Load this file plus at most one reference; use at most six targeted discovery calls and a 6,000-token soft context budget.
- Every tool call must discover, edit, or verify; after discovery use at most twelve additional tool calls.
- Never repeat unchanged state. Explain commands over one minute and report every 60 seconds.

## Execute one owner-authorized chain

Treat “fix and release” as one conditional authorization:

1. Reserve the next unused version before opening delivery and put that version,
   the fix, and its nearest focused regression in the same protected PR.
2. Run only that regression, directly coupled contracts, and changed-file
   formatting. Do not add a full-package rerun after the focused predicate passes.
3. Run changed-surface CI once and squash-merge the exact passing head.
4. Create the annotated tag at that merged commit.
5. Dispatch one tag-bound workflow that builds once, attests, publishes and
   advances the selected channel.
6. Read back the public tag and release result.

The ordinary bounded target is under ten minutes when GitHub infrastructure is
responsive: about two minutes for focused PR CI and six minutes for the one
cached, parallel tag-bound build and publication. Never merge the product fix
and then open a standalone version PR when release authority was already present.
The protected owner-created annotated tag is the publication approval; the
initial tag-bound workflow must not add a second environment-review pause.

Continue through those steps without requesting the same authority again. Stop
only for an actual failed predicate, changed identity, owner stop, or authority
that was not included in the request. A request for a fix without release
authority ends after the protected merge. If the same predicate fails twice,
report it and reassess its owner instead of repeating the command.

## Fix the literal predicate first

For every Fased issue, default to:

1. Preserve and inspect that exact environment and command.
2. Identify the first divergent predicate.
3. Add the nearest red-capable regression when needed.
4. Make one coherent correction.
5. Run that test, directly coupled contracts, and changed-file formatting.
6. Report or continue the active plan.

`reproduce -> focused regression -> fix -> focused test -> one literal runtime proof when required -> one PR/CI -> merge`

Keep diagnosis on the focused predicate. `fix and ship` means one locally
proven final diff, one push, one protected PR, one changed-surface CI result,
and an authorized exact-head squash merge.

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

Ordinary fixes use focused checks and produce no release artifact. An authorized
release uses one tag-bound workflow to build Linux-x64 once, attest those exact
bytes, run the production bootstrap/trust verifier, publish, and advance the
channel. The tag ref and peeled commit bind every official attestation.
Metadata-only promotion resumes an already published release without rebuilding.

The ordinary RC workflow is Linux-x64 only: one release job that never dispatches,
depends on, or waits for ARM64 or macOS. Portable supplements use a distinct,
explicitly owner-selected workflow only for a requested multi-platform release.
Assemble Linux-x64 once per public version because its JavaScript and native Go
binaries bind the version, commit, tree, and digest. Reuse dependency downloads
and Go compilation caches, never a prior assembled release or duplicate build.

Fresh Local and Hosting checks are owner-initiated after publication. Update the
existing owner-Local installation only when the owner authorizes it. Use literal
output supplied by the owner for an unreachable fresh Local machine, and connect
to a VPS only when the owner provides access. These checks report product
acceptance; they do not enter the default fix-and-release chain.

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
- Before an authorized host install or update that may require privilege, ask
  the owner to run `sudo -v` once in their own terminal so the sudo credential
  cache is active. Never request, accept, echo, or handle the sudo password in
  chat or tool input. After the owner confirms, check `sudo -n true` once. If
  unavailable, report `NOT RUN: sudo credential expired`; never poll or start a
  password prompt.

The canonical skill is
`docs/maintainers/codex-skills/fased-release-manager/`. Synchronize the installed
copy only after the canonical folder and harness validator pass.
