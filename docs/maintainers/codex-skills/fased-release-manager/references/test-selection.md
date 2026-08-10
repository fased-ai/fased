# Fased Test Selection

Use this only in `BUG/PR` mode. The public protected-base classifier is the
canonical PR selector. Do not run a private classifier, bind a gate, publish a
route status, or touch release state.

## Selection rule

For every changed path, name its owning surface and run the smallest test that
can fail for the reported predicate. Select the union for mixed changes.
Unknown production paths fail classification until a deterministic mapping is
added; a broad green Node test is not a substitute.

```text
symptom regression
+ directly coupled contract
+ changed-file format/lint
+ one T2 only if privilege/generated-unit ownership changed
```

Do not locally repeat jobs that the selected CI lane will run. PR CI never runs
packaged P1, fresh-install acceptance, real Hosting acceptance, publication,
or a release matrix.

## Surface map

| Surface                   | Closest evidence                                                                | PR expansion condition                                                                   |
| ------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| docs/version/metadata     | link/schema/version identity                                                    | no product build                                                                         |
| CI/classifier/workflow    | classifier and workflow-contract tests; actionlint/zizmor for changed workflows | no product lifecycle                                                                     |
| Node shared core          | nearest unit/contract test                                                      | full Node only when no safe subsystem map exists                                         |
| Gateway/CLI               | affected Gateway/CLI tests                                                      | build when distributable source changed                                                  |
| extension/plugin          | changed extension tests and package contract                                    | packaging only when package contents changed                                             |
| UI                        | affected node/browser test                                                      | UI build for browser/production UI changes                                               |
| Mining/SAT client         | Mining contracts, signer codec identity, affected UI test                       | no protocol/deployment gate unless protocol artifacts changed                            |
| Go signer                 | focused Go package tests                                                        | race tests when concurrency/lifecycle changed                                            |
| signer/Wallet integration | native signer and affected JS custody/RPC tests                                 | Darwin only when Darwin boundary changed                                                 |
| Local fresh               | nearest installer/bootstrap contract                                            | branch-local Linux x64 public-style transaction; exact candidate P1 remains release-only |
| Local update/service      | exact updater regression and rollback/retry source contracts                    | T2 only for root/generated-unit boundary                                                 |
| Hosting fresh/update      | Hosting adapter contracts                                                       | real VPS only at candidate/stable acceptance                                             |
| Docker/architecture       | affected image/architecture contract                                            | build only when image/runtime surface changed                                            |
| macOS                     | affected Swift/launchd/native contract                                          | macOS runner only when supported Apple surface changed                                   |
| experimental mobile       | known-path syntax/unit evidence                                                 | no Agent release lane                                                                    |
| skills                    | skill validator and affected script tests                                       | no product lifecycle                                                                     |

## Privileged T2

T2 is selected only when code changes root/app ownership, generated units,
controller/supervisor handoff, privileged sockets, signer isolation, or exact
rollback across that boundary.

Before running:

1. verify the narrow source regression is green;
2. run `sudo -n true` once;
3. if unavailable, report `NOT RUN: sudo credential expired` immediately; and
4. run the canonical same-host generated-unit fixture once.

T2 must prove a real controller A-to-B transition, receipt-bound identity and
capabilities before mutation, worker non-write access, injected failure,
rollback/retry, and unchanged critical-state digests. It is not a fresh install,
package bootstrap, container-only mock, P1, or owner acceptance.

## Updater and installer changes

Start from the exact reported user command and current authorized installation.
Do not create another user/home/state root/container/VM/VPS during diagnosis
unless the owner explicitly authorizes that boundary.

Required local sequence:

```text
exact symptom -> first predicate -> nearest red regression -> correction
-> regression green -> directly coupled checks -> optional T2
-> unpublished branch-local packaged original path
-> restart/preservation -> identical command Already current -> PR
```

The branch-local packaged proof is mandatory before the first push whenever
the correction changes installer, updater, supervisor, controller, service, or
migration behavior. Build unpublished artifacts from the exact branch commit
and exercise the public-style acquisition and handoff inside an isolated
systemd-capable boundary. Do not allocate a version, create a tag, publish, or
write release state. Fix additional predicates on the same branch and rerun
only this closure; do not create another PR as a diagnostic step.

Any product-source change after this proof invalidates it. Rerun the affected
Linux x64 transaction before push. Candidate P1 may expand to all supported
architectures, but it must not introduce a predicate that never passed locally.

Permission-only corrections run only the closest permission regression and its
direct ownership/atomic-write contract. They do not select UI, providers,
plugins, models, Gateway feature suites, packaging, or full Node tests unless
one of those production boundaries also changed.

Compatibility is selected by public manifest/schema/topology/capability, not by
every version string. A candidate P1 covers fresh protected Local plus latest
supported public stable to candidate. Add an older fixture only for a distinct
supported public contract. Mixed private-RC residue uses explicit repair and
does not expand normal updater logic.

## Signer and Wallet changes

Always preserve:

- native signer as the only production private-key operator;
- no raw secret material in JS/UI/Gateway state or logs;
- authenticated, authorized, replay-safe typed RPC;
- exact Wallet/account/network/policy binding;
- fail-closed capability/protocol negotiation; and
- rollback that preserves signer database and master-key identity.

Run focused Go tests and affected JS contracts. Add `go test -race` for
concurrency, service lifecycle, database locking, request deduplication, or
shutdown changes. Select WebAuthn, federation, Mining, or provider tests only
when their actual boundary changed.

## CI efficiency

- PR concurrency is keyed by PR number with obsolete heads cancelled.
- Classification prints selected jobs and reasons.
- Docs/version/fixture p95 target: 90 seconds.
- Focused product p95 target: three minutes.
- Cross-boundary installer/updater/signer PR p95 target: seven minutes.
- Privileged local T2 p95 target: five minutes.
- P1 is measured separately at the candidate boundary.
- Cache only dependencies/toolchains keyed by platform and exact lockfile,
  immutable base images, and exact public predecessor assets. Never cache state
  roots, signer/Wallet data, units, journals, or prepared root filesystems.
- Upload bounded diagnostics only on failure and preserve the first predicate.

If a focused PR exceeds its budget, inspect classification and setup time. Do
not restart it, add a plan generation, or broaden the matrix merely because it
is waiting.
