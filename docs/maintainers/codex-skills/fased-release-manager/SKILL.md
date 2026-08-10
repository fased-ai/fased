---
name: fased-release-manager
description: Manage focused Fased Agent fixes, tests, protected pull requests, Local and Hosting lifecycle changes, candidate and stable releases, GitHub assets, and npm handoff in /home/fc/fasedbot/fased. Use for any Fased bug, CI, installer, updater, signer, wallet, service, packaging, release, or update-instruction task.
---

# Fased Release Manager

Work only in `/home/fc/fasedbot/fased` or one explicitly selected Fased
worktree. Never scan all of `/home/fc/fasedbot`, every worktree, or archived
incident material. Preserve unrelated user changes.

This file is a small router. Select one lane before reading another reference
or running a test. The default lane is **FAST FIX**. A larger repository does
not justify a larger gate.

## Non-negotiable rules

- Follow the founder's current ordered plan. Do not silently add a PR, version,
  tag, build, candidate, publication, owner mutation, or broader test phase.
- A PR is delivery, never diagnosis. A candidate is final-byte confirmation,
  never the first execution of a predicate.
- Retain one process/session per command. Quiet output never authorizes a
  duplicate run.
- After the same product predicate fails twice, stop and report the ownership
  defect. Do not loop, broaden tests, or allocate another RC.
- Record only the first failed predicate, its class (`PRODUCT`, `HARNESS`,
  `ENVIRONMENT`, `AUTHORITY`, or `INFRASTRUCTURE`), the correction, and the
  do-not-repeat rule. Do not create a persistent workflow ledger.
- Use concrete versions only in fixtures and immutable evidence. Production
  compatibility is topology, persisted-state schema, and protocol capability.

## Choose exactly one lane

### FAST FIX — default

Use for ordinary source fixes and all docs, skill, workflow, classifier,
acceptance-contract, test-harness, fixture-only, metadata, and permission-only
changes.

1. Reproduce the exact symptom with the nearest red-capable test.
2. Make one coherent correction.
3. Run that test plus directly coupled contracts and changed-file format/lint.
4. Stop local testing when they pass.
5. For `fix and ship`, classify the completed diff once, push once, open one
   protected PR, and arm non-bypass squash auto-merge only after exact-head
   checks are known.

FAST FIX must not run a product build, package install, Docker/systemd fixture,
full Node suite, full CodeQL, PRE-CANDIDATE, P1, or release workflow unless the
changed bytes themselves require that operation. In particular:

- docs/skill/workflow/classifier/contract-only changes use only their contract
  tests;
- fixture-only changes reuse an existing verified product artifact and may
  alter only the disposable fixture copy;
- permission-only changes run the permission regression and its closest
  lifecycle contract, not UI, providers, plugins, models, or unrelated app
  tests;
- build only when generated runtime output can change.

Target: local feedback in seconds, focused PR CI in one to three minutes.

### LIFECYCLE — product mutation behavior changed

Use only when product code changes installer/updater planning, privileged
mutation, systemd/service topology, signer coordination, migration, rollback,
recovery, Local/Hosting adapters, or public acquisition/handoff behavior.

1. Run the nearest unit/regression test first.
2. Run only the directly affected Go/JS lifecycle packages.
3. When those pass, build one unpublished Linux-x64 artifact from the exact
   branch commit.
4. Run one public-style transaction for each affected topology only.
5. Reuse those exact bytes for rollback/retry, restart, preservation, and
   `Already current`; never rebuild between predicates.
6. Push/open one PR only after the affected branch transaction is green.

Do not build ARM or macOS assets in this lane. Do not run a complete release
matrix. A source change invalidates the branch artifact; a harness-only change
does not and must reuse it.

The branch and candidate use the same non-executable acceptance contract. For
the applicable scenario it records:

`artifact identity -> public command -> canonical lifecycle -> four services -> wallet status -> wallet signer doctor -> mining status -> network status -> plugin doctor -> restart -> state preservation -> rollback/retry when applicable -> Already current`

No candidate predicate may execute for the first time.

### RELEASE — explicit release intent only

Enter only when the founder says `release candidate`, authorizes the equivalent
sequence, or explicitly asks to continue an active release.

`exact merged main -> PRE-CANDIDATE -> version-only PR -> owner immutable tag -> trusted build once -> parallel P1 against exact bytes -> publication approval -> GitHub -> owner npm beta -> PUBLIC0 -> owner Local -> real Hosting -> stable`

- PRE-CANDIDATE verifies merged identity and reuses already-passing source
  predicates. It must not discover a new product command.
- Build every supported target once only at the immutable candidate boundary.
- Run independent P1 scenarios concurrently against the same artifact.
- Never rebuild between P1 and publication.
- A product failure returns to one FAST FIX or LIFECYCLE branch. It never
  allocates a replacement version until local closure and merged-main proof
  pass.
- Publication, owner Local, real Hosting, npm, and stable remain owner
  boundaries unless the current instruction explicitly authorizes them.

Future public compatibility coverage derives release tag, commit, tree,
topology group, and acceptance-contract identity from immutable attested public
manifests. Never open a per-RC source PR merely to append a published release.

## Commands from the founder

- `fix and ship`: FAST FIX or LIFECYCLE as selected by changed behavior; one
  locally closed correction, one PR, protected squash auto-merge. No release.
- `review queue`: read-only PR review. Inspect only relevant diffs/checks;
  never merge without a separate founder instruction.
- `release candidate`: RELEASE through build-once/P1, stopping at the protected
  publication boundary unless broader authority is explicit.

Do not perform a GitHub PR-queue preflight for every local task. Inspect the
queue only for `review queue`, immediately before opening a PR, or when a known
remote dependency can affect the active change.

## Failure and latency discipline

- Before work expected to exceed one minute, verify cwd, disk/inodes, writable
  caches, sudo, network/credentials, reusable artifacts, and existing sessions.
- State the command, why the selected lane requires it, and its expected phase.
- Report progress at least once per minute without restarting the command.
- Retry infrastructure/environment failures once only after correcting the
  exact condition. Never rerun unchanged product/harness failures.
- Full Node/application suites and broad security matrices belong to nightly
  or candidate validation unless the complete dependency/product boundary
  genuinely changed.
- Cache toolchains, dependency stores, container bases, and immutable
  predecessor assets. Never cache mutable installation state, journals,
  Wallets, or signer data.

## Lifecycle architecture guardrail

`tools/fased-lifecycled` is the sole lifecycle mutation engine. JavaScript may
acquire/verify artifacts and translate CLI results, but must not gain a second
planner, service mutator, signer migration owner, rollback engine, or recovery
journal. Local and Hosting are adapters around the same transaction. Preserve
user state, fail closed on unknown-newer schemas, roll back safely, and make an
identical command return `Already current`.

## Reference routing

Do not read every reference. Read only what the chosen lane needs:

- test selection or CI routing: `references/test-selection.md`;
- candidate/publication/npm: `references/release-flow.md`;
- authority and immutable evidence: `references/policy.md`;
- lifecycle implementation: `references/lifecycle-architecture.md`;
- signer/Wallet custody: `references/signer-lifecycle.md`;
- approved updater demolition/cutover: `references/universal-install-update-plan.md`.

FAST FIX normally needs zero or one reference. RELEASE may need policy,
test-selection, and release-flow. Archived incident reports are evidence, never
executable instructions.

## npm owner boundary

Prepare and dry-pack the exact package, then print a plain standalone command:

`npm publish <path> --ignore-scripts --access public --tag beta`

Never print, request, accept, store, or pass an OTP/token. The owner runs npm
publication manually; afterward perform readback/PUBLIC0 without rebuilding.

## Authority

Standing `fix and ship` authority covers one branch, one push, one protected PR,
and non-bypass squash auto-merge after required checks pass. Never use
`--admin`, weaken protection, or merge around failed checks.

Versions, tags, GitHub Releases, npm publication, owner infrastructure, and
stable promotion require the exact authority stated by the current user.

The bundled canonical copy lives at
`docs/maintainers/codex-skills/fased-release-manager/`. Sync the installed skill
only from that validated copy; never load workflow authority from a dirty docs
checkout.
