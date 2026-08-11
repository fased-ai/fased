# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact `origin/main` commit whose affected predicates and
public-style Linux-x64 lifecycle transaction already pass. Bind the actual
owner Local predecessor as well as the latest supported stable predecessor. If
they differ, both paths must already pass against the same branch artifact.

```text
PRE-CANDIDATE
-> version-only protected PR
-> owner immutable tag at exact main
-> trusted build once
-> parallel P1 against the exact artifact set
-> protected publication approval
```

PRE-CANDIDATE verifies frozen dependencies, production audit, release/package
identity, compatibility inventory, and public acquisition inputs. It must not
discover a new product command.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names/sizes/digests, provenance, SBOM/VEX, signer/controller identity,
and acceptance-contract identity. Build each supported target once. Publication
downloads and verifies those bytes; it never rebuilds.

P1 covers fresh protected Local, latest supported public stable to candidate,
rollback/retry, restart, declared-state preservation, product/service health,
and `Already current`. It also replays the exact owner Local predecessor when
that differs from stable; this is an owner-acceptance prerequisite, not broad
historical compatibility. Independent predecessor lanes run concurrently and
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
