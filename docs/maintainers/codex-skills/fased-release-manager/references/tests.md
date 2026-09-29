# Focused Tests and Delivery

Read this file only to select validation or ship a fix.

## Codex harness validator

For the global harness, this skill, or the installed Local acceptance runner,
run the single deterministic validator:

`node /home/fc/fasedbot/docs/maintenance/git_manage/codex/scripts/validate-codex-harness.mjs --fased-root /home/fc/fasedbot/fased`

Use `--canonical-only` before synchronizing home configuration. The full form
must pass afterward; separate greps are not a substitute.

## Selection

Run the smallest test that can fail for the changed predicate, directly coupled
contracts, and changed-file formatting. Mixed changes use the union of their
focused tests. Unknown production paths require a classifier mapping; they do
not justify an indiscriminate full suite.

Before running tests, identify the changed predicate and the smallest command
that can falsify it. Select explicit files or test names; add coupled cases only
for shared contracts, state transitions or dependencies affected by the change.
Keep useful regression tests in the repository without invoking them every turn.

- Text/skill-only changes: the owning validator and changed-file formatting;
  no Go, Rust, browser, bank, economic matrix or runtime suite.
- Leaf implementation changes: nearest regression first. Run the affected joined
  journey once its connected changes are ready, not after each leaf edit.
- Packaging, resource measurements, installed acceptance and economic matrices:
  run at their owning milestone or when their relevant inputs change. They are
  not default prerequisites for every WEN task.
- Reuse passing evidence only while relevant source, generated artifacts,
  dependencies, configuration and environment assumptions remain valid. New
  failures or a specific unresolved concern justify targeted reruns. Preserve
  required protected CI and acceptance gates; local reuse cannot waive them.
- Capture full output in a log when useful; report the selected scope, result,
  failures and evidence path rather than dumping successful case output.

Command traps: `pnpm test` selects the parallel suite; `pnpm test:fast` without
file filters selects the unit suite; `pnpm test:all` additionally runs lint,
build, E2E, live and Docker suites. None is the default focused command. Prefer
`pnpm exec vitest run --config vitest.unit.config.ts <affected-test-file>`;
use the owning browser/E2E configuration only for tests that require it. For
Go or Rust, select the affected package/test target and case filter, broadening
only when the changed contract requires it.

| Change                          | Evidence                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| docs or skill                   | validator only                                                                                             |
| workflow or classifier          | static workflow/classifier contracts                                                                       |
| Node, CLI, UI, plugin           | nearest affected unit/contract test                                                                        |
| dependency remediation          | frozen install, audit, lock/path integrity, affected tests                                                 |
| Go signer                       | affected Go package; race test only for concurrency                                                        |
| permission or fixture           | exact regression; reuse existing product bytes                                                             |
| privileged unit/socket/rollback | focused tests, then one root-capable T2                                                                    |
| lifecycle product behavior      | focused tests, then affected Linux-x64 public transaction                                                  |
| managed repair or uninstall     | exact-current/no-selection test, rollback or resume test, preserved-state proof, then T2                   |
| Hosting host-security ownership | adopted-control no-mutation, first-install baseline, interrupted restore, then real owner-operated Hosting |

Do not run full Node, full CodeQL, Docker, packaging, broad platforms, or
release acceptance for an unrelated small fix. Build only when distributable
runtime bytes can change.

## Lifecycle branch proof

When lifecycle product behavior changed, use one unpublished Linux-x64 artifact
keyed by commit, tree, and lockfile digest. Exercise only the affected real
Local or Hosting environment. Reuse the artifact for rollback/retry, restart,
preservation, release, tag and publication. A container may retain transaction-level
diagnostic value, but it is optional `SUPPORTING` evidence and never acceptance.

For an exact-runner packaging or archive proof, run one attempt per materially
changed producer commit after focused local and protected PR checks pass. The job
timeout is an emergency ceiling, not a planned wait: derive it from a cold-run
baseline plus a small buffer and normally keep a diagnostic branch proof within
15 minutes. Give each phase an independent destination-side progress signal and
normally no more than 120 seconds of inactivity. A longer phase budget requires
evidence that one valid entry or operation needs it.

On archive failure, upload only the small JSON receipt and log with manifest
count, completed count, active path/type/declared size, active-entry bytes, and
destination bytes. Inspect that receipt immediately. Do not retry unchanged,
raise the timer, rebuild candidate bytes, or wait for the job ceiling without a
new causal correction.

T2 is required only for changed root ownership, generated units, privileged
sockets, controller handoff, signer isolation, or rollback across that boundary.
Check `sudo -n true` once; if unavailable, report it and stop.

## Shipping

For `fix and ship`:

`focused local PASS -> classify final diff once -> push once -> one protected PR -> focused CI -> squash merge`

PR CI must not build release artifacts, publish, or repeat packaged
lifecycle acceptance. Superseded runs cancel. Do not restart quiet CI; inspect
one existing run. Target one to three minutes for ordinary PRs. A route that
selects unrelated suites is a classifier defect, not permission to wait longer.

## Mandatory disk hygiene

- Before builds/tests, reuse unchanged outputs and the existing compatible cache. Do not create a new Cargo target, Go cache, dependency tree or worktree per task by default. Keep incompatible toolchains/configurations separate; never share writable outputs across concurrent builds.
- Use one task-scoped scratch directory outside the workspace root. Register cleanup at creation (shell EXIT trap or test finally/afterAll); failures and cancellations must also clean disposable fixtures.
- Measure only the task's build/cache/scratch paths before and after expensive work. If disposable outputs grow by more than 2 GiB during the task, inspect and prune superseded outputs before starting another build. This is a review trigger, not permission to delete required files or rebuild repeatedly.
- Before the final report, remove task-created unused caches, scratch directories, test installations and redundant binaries. Remove a task-created worktree through Git only after its unique work is preserved and no active process/dependency needs it. A passing test is not completion while unexplained temporary output remains.
- Keep one intentional reusable cache per compatible build setup. Do not archive disposable compiler caches merely to move clutter elsewhere. Retain required binaries/evidence once, with exact paths, purpose and deletion condition in the existing tracker.
- Preserve source, dirty/untracked work, keys, signer/runtime state, recovery backups and required evidence. For older directories, classify contents and check active use first; never delete by name, age or size alone. Report cleanup done and any retained exception with its reason.
