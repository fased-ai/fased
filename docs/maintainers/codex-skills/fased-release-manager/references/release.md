# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact `origin/main` commit whose affected predicates and
public-style Linux-x64 lifecycle transaction already pass.

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
and `Already current`. Add another predecessor only for a materially distinct
supported schema/topology/capability. Independent lanes run concurrently.

Product failure returns to one normal fix and requires a new immutable identity
only after local and merged-main closure. Infrastructure failure may retry the
failed job once against unchanged bytes.

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

The owner performs npm publication manually:

`npm publish <path> --ignore-scripts --access public --tag beta`

Never handle OTP, login, or token material. Verify npm and GitHub readback after
the owner finishes.
