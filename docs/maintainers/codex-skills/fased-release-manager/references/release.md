# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact `origin/main` commit whose affected predicates and
public-style Linux-x64 lifecycle transaction already pass. Bind the actual
owner Local predecessor as well as the latest supported stable predecessor.
When an installed legacy updater requires authentic target-tag-bound
attestations, the owner transition cannot pass against an untagged branch
artifact. Record that boundary explicitly and defer only that transition to the
trusted tagged workflow; never substitute a synthetic verifier or bundle.

```text
PRE-CANDIDATE
-> version-only protected PR
-> exact merged-main pre-tag candidate-shaped P1 for executable trust routes
-> owner immutable proof-enabling tag at exact main
-> trusted build and authentic target attestations once
-> parallel P1, including the deferred owner transition, against the exact artifact set
-> protected publication approval
```

PRE-CANDIDATE verifies frozen dependencies, production audit, release/package
identity, compatibility inventory, and public acquisition inputs. It must not
discover a new product command.

The pre-tag P1 uses the exact Local and Hosting fixture entrypoints, container
mount layout, acquisition URL map, candidate-shaped artifact inventory, and
receipt verifier used after tagging. It runs on the same protected Linux runner
class. A tag is forbidden when any executable fixture, artifact name, transport
route, or acceptance predicate has not executed there. If a legacy updater
requires a target-tag-bound attestation, pre-tag evidence must name the deferred
canonical-managed class and the post-tag workflow must make its authentic
transition a hard publication dependency.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names/sizes/digests, provenance, SBOM/VEX, signer/controller identity,
and acceptance-contract identity. Build each supported target once. Publication
downloads and verifies those bytes; it never rebuilds.

P1 covers fresh protected Local, latest supported public stable to candidate,
rollback/retry, restart, declared-state preservation, product/service health,
and `Already current`. It also replays the exact owner Local predecessor when
that differs from stable; this is an owner-acceptance prerequisite, not broad
historical compatibility. When target authentication is tag-bound, this owner
lane runs only after the trusted build has issued authentic attestations and
still blocks publication. Independent predecessor lanes run concurrently and
consume the same candidate artifact.

Product failure returns to one normal fix and requires a new immutable identity
only after local and merged-main closure. Infrastructure failure may retry the
failed job once against unchanged bytes.

Once source changes after an immutable tag, mark that candidate obsolete. Its
tag and bytes remain immutable, but it cannot be repaired, rebuilt, republished,
or used for owner acceptance. Allocate the next unused version only after the
corrected branch paths and exact merged-main PRE-CANDIDATE pass.

## Publication and acceptance

```text
GitHub prerelease exact bytes
-> owner npm beta
-> PUBLIC0 readback
-> owner Local
-> real Hosting
-> stable promotion
```

PUBLIC0 is readback-only. Owner Local uses the literal public command and proves
four services, Wallet/signer, Mining, Network, plugins, restart, preserved state,
and `Already current`. Real Hosting requires an authorized VPS/Tailscale
environment; containers are supporting evidence only.

Stable promotion reuses accepted candidate bytes and changes only authorized
release/dist-tag metadata.

## Authority

Do not create, move, delete, publish, or promote versions/tags/releases without
the current explicit authority. Never bypass protected checks or environment
review.

When the owner has explicitly authorized the sequence through publication,
submit that existing approval as soon as every immutable P1 lane passes. Do not
ask for the same approval again, weaken the environment, or allow the workflow
to self-approve. A failed or incomplete P1 cancels that publication action.

The owner performs npm publication manually:

`npm publish <path> --ignore-scripts --access public --tag beta`

Never handle OTP, login, or token material. Verify npm and GitHub readback after
the owner finishes.
