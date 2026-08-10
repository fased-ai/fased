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

## Controlling Plan Lock

When the founder approves an ordered plan or named checkpoints, treat that plan
as the controlling execution contract until the founder explicitly replaces or
amends it. Before the first mutation, state the active checkpoint, its allowed
changes, its required evidence, and its stop condition.

- Execute only the active checkpoint. Never skip ahead, reorder checkpoints,
  substitute a different topology, or perform a later PR, version, tag, build,
  publication, cleanup, or owner mutation early.
- Before every mutating command, map the action to an explicit active-checkpoint
  step. If it does not map, do not run it.
- A discovery or failed predicate freezes the active checkpoint. Report expected
  versus actual behavior and the first failed predicate; do not invent a
  replacement sequence, candidate, compatibility branch, or workaround.
- Propose a plan amendment when the approved plan is contradictory or no longer
  safe. Do not execute that amendment until the founder explicitly approves it.
- `continue`, `do it`, `finish`, prior standing PR authority, and release
  authorization never permit deviation from the controlling plan.
- Mark a checkpoint complete only after its declared evidence passes. If the
  plan says to stop and report, stop before beginning the next checkpoint.
- If multiple plans conflict, freeze mutation and ask the founder to select one
  canonical ordering. Never silently combine them.
- Never allocate a replacement RC for a source, workflow, or proof failure.
  Return to the plan's BUG/local-proof checkpoint and keep all corrections on
  the same local branch until its complete closure passes.

Maintain a compact checkpoint ledger in progress updates:

`checkpoint | allowed mutation | required proof | status | next boundary`

System/developer safety requirements still take precedence. When they conflict
with the plan, stop and report the conflict instead of silently deviating.

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
6. Run changed-file format/lint checks, create the final local commit, and run
   the protected-base classifier once against the complete `origin/main...HEAD`
   path set. Classify the coherent multi-file change, never each file in
   isolation. If the protected base rejects or unexpectedly broadens the route,
   correct classification locally before the first push. Then push once and
   use one PR. Do not open a draft or diagnostic PR.
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

## Parallel Execution and Latency Discipline

Use available subagents for independent, bounded work whenever the founder asks
to parallelize or speed up execution. Keep one mutation owner: the primary
agent alone edits the active incident branch unless files are explicitly
partitioned with no overlap.

- Parallelize read-only source review, safety review, disk/environment audit,
  fixture review, CI inspection, and independent test-result analysis.
- Run independent narrow tests concurrently only when they do not contend for
  the same worktree, cache, service, port, container, or privileged state.
- Never parallelize owner-installation mutation, lifecycle transactions,
  destructive cleanup, merge/tag/publication boundaries, or two edits to the
  same files.
- Before an expensive proof, check disk, sudo, network, credentials, existing
  processes, and reusable artifacts. Reuse caches and exact bytes; do not
  rebuild unchanged product code for a test-only correction.
- Keep one retained session for each long-running test or CI run. Poll that
  session; never start a duplicate because output is quiet or context changed.
- Poll GitHub by one run ID with bounded JSON every 30-60 seconds. Do not stream
  verbose `run watch` output, redownload the job graph, or continuously poll a
  protected wait. Report the active job and leave it running.
- Run changed-package and closest-regression tests first. Broaden only after
  they pass and only when the affected trust or lifecycle boundary requires it.
- If a harness or environment predicate fails, repair that predicate and rerun
  only its bounded proof. If the same product predicate fails twice, stop and
  report instead of looping.
- During work exceeding one minute, report the active command, elapsed time,
  current phase, and whether it is product work or supporting evidence.

Parallel work reduces diagnosis latency; it never weakens the controlling plan,
evidence bindings, or founder approval boundaries.

### Failure learning

Maintain one compact in-session failure ledger:

`predicate | class | root cause | correction | do-not-repeat rule`

Classify each failure as `PRODUCT`, `HARNESS`, `ENVIRONMENT`, `AUTHORITY`, or
`INFRASTRUCTURE` before changing code or rerunning anything.

- Never rerun an unchanged command after a `PRODUCT` or `HARNESS` failure.
  Inspect the first failing predicate, correct it, run its closest fast test,
  then permit one bounded retry.
- Retry `ENVIRONMENT` or `INFRASTRUCTURE` once only after correcting the exact
  condition, such as sudo expiry, disk quota, network failure, wrong working
  directory, socket path length, or read-only cache.
- Before every long proof, verify the working directory, disk and inode budget,
  writable temp/cache paths, required credentials, existing processes, artifact
  identity, and that the fault injector does not mutate attested bytes.
- A source change invalidates its product artifact. A fixture-only change does
  not; reuse the exact artifact and avoid rebuilding.
- When an artifact transport loses executable mode, stage a fixture-only copy,
  set the required mode there, and prove byte-for-byte digest equality. Never
  modify attested bytes or rebuild the product for a permission-only harness
  correction.
- Any product-source change after local closure makes that closure stale. Rerun
  the affected Linux x64 branch transaction before push; never carry closure
  evidence across a product commit.
- Record elapsed time and terminal output from one retained process session so
  context compaction cannot cause a duplicate run.
- After closure, add only confirmed, reusable, version-neutral prevention rules
  to this skill or its existing references. Never persist RC names, temporary
  paths, raw receipts, or incident-specific state as workflow policy.
- Keep the ledger under ten entries. Consolidate repeated causes into one rule;
  do not create another persistent workflow database or approval state machine.

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
- Keep development proof small: build Linux x64 only and run only the affected
  Local or Hosting topology. Multi-architecture packaging belongs to the final
  immutable candidate, not the bug loop.
- Use the fixture builder's `branch-x64` profile for development proof. It may
  create non-executable copy-on-write aliases solely to satisfy the public manifest
  schema, but must mark the artifact non-publishable and compile no ARM or macOS
  binaries. Never feed this fixture artifact to candidate publication.
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
- No candidate predicate may execute for the first time. Every source-dependent
  P1 assertion must already have an equivalent passing branch-local predicate.

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
Run independent candidate P1 scenarios concurrently against the same immutable
artifact: fresh Local, supported-stable update with rollback/retry, and Hosting
adapter proof. Cache toolchains, dependency stores, base images, and exact
public predecessor assets; never cache installation state, journals, Wallet or
signer data. Full Node/application suites belong to scheduled CI unless the
resolved source change genuinely affects the whole product.

### Owner-operated npm boundary

Codex prepares the exact candidate checkout, installs the frozen lockfile,
builds once when npm package contents require it, and dry-packs the complete
authoritative package inventory. Codex then prints plain, standalone
`npm publish <path> --ignore-scripts --access public --tag beta` commands for
the owner to run manually. Do not print, request, accept, store, interpolate,
or pass an OTP; do not include `--otp`, login, token, or secret-handling syntax.
Do not invoke `npm publish` from the agent environment. After the owner reports
completion, read back every exact package version and dist-tag, then run
PUBLIC0 once without rebuilding or replaying P1.

## Simplicity and Compatibility

Do not add another lifecycle state machine, release gate, private-RC production
branch, or historical release matrix. Compatibility is defined by public
persisted-state schema, installed topology, and protocol capability—not a
release name. Concrete versions belong only in fixtures and immutable evidence.

For lifecycle convergence, treat `tools/fased-lifecycled` as the sole target
implementation for planning, privileged mutation, activation, health,
commit, rollback, and recovery. Freeze the JavaScript bootstrap, supervisor,
host-updater, and managed-runtime mutation paths: they may be reduced or
deleted, but must not receive new lifecycle behavior. Keep JavaScript only as
the unprivileged acquisition/attestation/CLI wrapper and any temporary,
explicitly bounded public-stable bridge until the equivalent Go transaction
passes packaged closure. Never let old and new owners mutate one installation.

For updater work preserve one manifest, lock, logical transaction, shared
engine, and Local/Hosting adapters. Bind separate supervisor and target-controller
journals to the same transaction identity; each authority exclusively owns its
mutation and recovery decisions. Preserve user state, fail closed on unknown
newer schemas, roll back interrupted mutation, retry the same command, restart
and verify health, and require `Already current` on repetition. Repair private
development residue once; do not teach production to recognize it forever.

For a multi-checkpoint lifecycle cutover, close one checkpoint at a time and
report `PASS`, `FAIL`, or `NOT RUN` with the exact command, duration, changed
files, and first failed predicate. Do not silently work for more than ten
minutes. A failed checkpoint freezes later checkpoints; do not compensate with
a PR, candidate, broader matrix, or alternate release identity.

## Authority

After all mode-specific local closure requirements pass, standing authorization
covers the routine protected PR lifecycle for the active correction: one final
push, one PR, aggregate checks, non-bypass squash merge, branch deletion, and
exact synchronization to `origin/main`. Before local closure passes, standing
authorization covers local branch work only. Never use `--admin` or weaken
protection.

Version changes, tags, GitHub Releases, Docker publication, npm publication,
and owner infrastructure remain explicit boundaries unless the current user
instruction grants that exact sequence. npm package publication is always a
manual owner command boundary; Codex prepares, prints, and verifies it but does
not execute it or handle authentication material.
