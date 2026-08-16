# Focused Tests and Delivery

Read this file only to select validation or ship a fix.

## Selection

Run the smallest test that can fail for the changed predicate, directly coupled
contracts, and changed-file formatting. Mixed changes use the union of their
focused tests. Unknown production paths require a classifier mapping; they do
not justify an indiscriminate full suite.

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
keyed by commit, tree, and lockfile digest. Run only affected Local/Hosting
topologies. If both fresh and stable-update are required, run them concurrently
with isolated state. Reuse the artifact for rollback/retry, restart,
preservation, and `Already current`. Fixture-only corrections cannot rebuild it.

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

PR CI must not build release artifacts, run P1, publish, or repeat packaged
lifecycle acceptance. Superseded runs cancel. Do not restart quiet CI; inspect
one existing run. Target one to three minutes for ordinary PRs. A route that
selects unrelated suites is a classifier defect, not permission to wait longer.
