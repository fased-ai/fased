---
name: fased-release-manager
description: Manage focused Fased Agent fixes, tests, protected pull requests, Local and Hosting lifecycle changes, candidate and stable releases, GitHub assets, and npm handoff in /home/fc/fasedbot/fased. Use for any Fased bug, CI, installer, updater, signer, wallet, service, packaging, release, or update-instruction task.
---

# Fased Release Manager

Work in `/home/fc/fasedbot/fased`. Preserve unrelated changes. Prefer one clean
worktree based on `origin/main`; never use an arbitrary dirty docs checkout as
workflow authority. This installed directory is an executable snapshot of the
protected canonical skill at
`docs/maintainers/codex-skills/fased-release-manager/` in `fased-ai/fased`;
update it only from a validated exact protected `origin/main` copy.

## Session Preflight

Once at the beginning of each Fased session, inspect the live open-PR queue
read-only before mutating source or release state:

```bash
gh pr list --repo fased-ai/fased --state open \
  --json number,title,author,isDraft,updatedAt
```

Report external contributions, PRs awaiting founder action, and failed or stale
checks. Fetch check details only for new, external, failed, or founder-relevant
PRs; never download every check rollup during session startup. Do not poll,
restart CI, merge, or block an explicitly scoped task because an unrelated PR
exists. If GitHub is unavailable, report the preflight as unavailable and
continue safe local work.

## Choose One Mode

- `REPORT`: inspect and report only.
- `BUG/PR`: reproduce one predicate, fix it, complete the affected local
  closure, and only then use one protected PR.
- `RELEASE`: begin only from an exact merged `origin/main` commit after release
  authorization.

Do not mix modes. Ordinary bug work must never read or mutate release ledgers,
candidate receipts, private status publishers, or historical workflow state.

## Founder Commands

Treat these literal user commands as scoped workflow authorization:

- `fix and ship`: select `BUG/PR`; diagnose and close one scoped correction
  locally, push once, open one protected PR, and arm squash auto-merge after the
  exact PR head and required checks are confirmed. GitHub merges only when
  protection passes. This command does not authorize a version, tag, release,
  npm publication, or owner-infrastructure mutation.
- `review queue`: select `REPORT`; inspect every open PR's author, diff,
  checks, security impact, and mergeability. Return `PASS`, `REQUEST CHANGES`,
  or `REJECT` with reasons. Never merge an external contribution without a
  separate founder instruction such as `approved` or `merge PR #N`.
- `release candidate`: select `RELEASE`; authorize `PRE-CANDIDATE`, the strictly
  version-only candidate PR, trusted build once, and packaged P1 once. The
  owner-authorized immutable tag must exist before the candidate workflow is
  dispatched from that tag. Stop when the publication job is waiting at the
  protected environment. The owner tag, GitHub Release publication, npm, owner
  Local or Hosting mutation, and stable promotion remain explicit boundaries
  unless the same instruction grants them.

These shortcuts consume the existing focused CI routing. Do not edit, broaden,
or duplicate CI merely to implement a shortcut.

## Fast Bug and PR Lane

For broken, failing, incorrect, or slow behavior, use `diagnosing-bugs` and:

1. Lock scope to the exact symptom, profile, and user command.
2. Run the smallest deterministic red-capable test. Name its first failed
   predicate.
3. Check sudo, credentials, network, disk, and interactivity before expensive
   work. Before a sudo-bound test run `sudo -n true`; if it fails, report
   `NOT RUN` and ask the owner for `sudo -v`. Do not wait or retry blindly.
4. Make one coherent correction and rerun only the narrow regression plus its
   directly coupled test.
5. For installer, updater, supervisor, controller, service, or migration code,
   remain on one local incident branch until the branch-local packaged proof in
   **Lifecycle Bug Closure** passes. A PR is delivery, never diagnosis.
6. Run changed-file format/lint checks, commit locally as needed, then make one
   final push and use one PR. Do not open a draft or diagnostic PR.
7. When `fix and ship` or a separate founder merge instruction applies, use
   `gh pr merge --auto --squash --delete-branch`. Never use `--admin`. Arm it
   only after local closure, exact-head readback, and required-check discovery;
   do not poll while GitHub waits for protection.
8. If GitHub reports the authorized PR as `BEHIND`, run
   `gh pr update-branch <number>` once and let strict checks rerun. Do not update
   an unclassified, conflicted, or unauthorized PR.
9. On CI failure, inspect only the first failed predicate. Retry infrastructure
   failures at the failed job; change source only for product failures.

Default ordinary-bug path:

`symptom -> narrow red -> coherent fix -> narrow green -> one PR -> focused CI -> squash merge`

Installer/updater/lifecycle work must use **Lifecycle Bug Closure** below
instead; never apply this shorter path to those boundaries.

Budgets: ordinary local correction under five minutes; docs/version/fixture PR
CI under 90 seconds; focused product PR CI under three minutes; cross-boundary
installer/updater/signer PR CI under seven minutes. Do not run builds, OS
fixtures, fresh installs, packaged lifecycle, Hosting, historical matrices, or
release gates unless the changed boundary requires them. State the reason
before expanding scope.

For a dependency-only correction, use:

`frozen install -> production audit -> lockfile integrity -> affected dependency path -> affected package tests -> build only when runtime output can change`

Do not run the full Node suite merely because the root manifest or lockfile
changed. Run it only when the resolved change can affect the whole product and
name that evidence; otherwise leave the full matrix to scheduled or candidate
validation.

## Lifecycle Bug Closure

Before the first remote push for an installer/updater/lifecycle incident, use
one local branch and prove the complete affected transaction with unpublished,
branch-built artifacts:

`exact failure -> regression -> correction -> coupled tests -> optional T2 -> branch-local packaged public-style transaction -> restart/preservation -> identical command Already current`

- Exercise the same acquisition, attestation, handoff, rollback, and service
  path the end user uses; an in-process unit test or T2 alone is insufficient.
- Use an isolated disposable systemd fixture unless the task explicitly owns a
  real installation. Never mutate an owner installation with unversioned source.
- Fix every newly exposed predicate on the same local branch. Do not open,
  replace, or multiply PRs, candidates, or versions during diagnosis.
- Stop after the same predicate fails twice and report the ownership defect;
  do not add another compatibility branch or retry loop.
- Record one compact local-closure result bound to commit, tree, artifact
  digest, topology/schema/capability, and state digests. It is development
  evidence, not a release receipt.
- Only a complete local closure activates standing authorization for the one
  protected PR. PRE-CANDIDATE later confirms merged-main identity; it must not
  be the first packaged execution of corrected lifecycle code.

## Release Lane

Read bundled references, never absolute files from `/home/fc/fasedbot/docs`:

- always: `references/policy.md`;
- test selection: `references/test-selection.md`;
- candidate, publication, or npm: `references/release-flow.md`;
- install, update, migration, Local, or Hosting:
  `references/lifecycle-architecture.md`;
- signer or Wallet lifecycle: `references/signer-lifecycle.md`;
- updater consolidation status: `references/universal-install-update-plan.md`.

Release path:

`clean merged main -> PRE-CANDIDATE PASS -> version-only PR -> owner tag -> trusted build once -> packaged P1 once -> publication approval -> exact GitHub bytes -> owner npm beta -> PUBLIC0 -> owner Local -> real Hosting -> stable`

For installer or updater changes, `PRE-CANDIDATE PASS` must include the exact
public-style acquisition path before any version is allocated:

`stamped installer -> candidate asset inventory -> every public attestation -> lifecycle transaction -> restart/preservation -> identical command Already current`

Directly downloading an Actions artifact into P1 is not proof of the public
installer/updater path. Require both fresh Local and supported-stable update
through the same entry point users run. Search for and consolidate every
duplicated trust/policy predicate before fixing one occurrence. If the literal
owner command later reaches an untested predicate, classify the release
workflow as failed, freeze all version/tag/publication work, and return to
`BUG/PR` until this pre-publication coverage gap is closed.

For lifecycle corrections, PRE-CANDIDATE repeats the already-passing local
closure against exact merged main. It never substitutes for branch-local
closure and never discovers the first packaged product failure.

`PRE-CANDIDATE PASS` is mandatory before editing any version. On the unchanged
merged source, require frozen install, production audit, release validation,
compatibility/public-inventory verification, and candidate-input preflight.
Record the exact commit and results. Candidate versions are never diagnostic:
do not bump, tag, dispatch, or reserve one while any source-dependent predicate
is failing or unrun. A failure returns to `BUG/PR`; it does not allocate an RC.

Never rebuild between P1 and publication. A publication failure reruns only
publication. Containers are supporting fixtures, not real Hosting acceptance.

## Simplicity and Compatibility

Do not add another lifecycle state machine, release gate, private-RC production
branch, or historical release matrix. Compatibility is defined by public
persisted-state schema, installed topology, and protocol capability—not a
release name. Concrete versions belong only in fixtures and immutable evidence.

For updater work preserve one manifest, lock, logical transaction, shared
engine, and Local/Hosting adapters. Bind separate supervisor and target-controller
journals to the same transaction identity; each authority exclusively owns its
mutation and recovery decisions. Preserve user state, fail closed on unknown
newer schemas, roll back interrupted mutation, retry the same command, restart
and verify health, and require `Already current` on repetition. Repair private
development residue once; do not teach production to recognize it forever.

## Authority

After all mode-specific local closure requirements pass, standing authorization
covers the routine protected PR lifecycle for the active correction: one final
push, one PR, aggregate checks, non-bypass squash merge, branch deletion, and
exact synchronization to `origin/main`. Before local closure passes, standing
authorization covers local branch work only. Never use `--admin` or weaken
protection.

Version changes, tags, GitHub Releases, Docker publication, npm publication,
and owner infrastructure remain explicit boundaries unless the current user
instruction grants that exact sequence. npm remains owner-operated unless
explicitly authorized.
