# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact `origin/main` commit whose affected predicates and
public-style Linux-x64 lifecycle transaction already pass. Bind every
materially distinct supported installation class by topology, schemas,
capabilities, and platform identity. Concrete versions only materialize those
classes; the owner's installed RC is never a separate product contract.

```text
exact branch head
-> one unpublished, tag-free candidate-shaped Linux-x64 build
-> serial LOCAL0 fresh/update/takeover Local and Hosting fixtures
-> concurrent LOCAL0 confirmation against the identical cached artifact
-> rollback/retry/restart/preservation/identity/Already current
-> protected source PR with byte-identical squash tree
-> PRE-CANDIDATE on exact merged main
-> version-only protected PR
-> exact merged-main pre-tag candidate-shaped P1 for supported topology classes
-> owner immutable proof-enabling tag at exact main
-> trusted build and authentic target attestations once
-> parallel P1 against the exact artifact set
-> protected publication approval
```

`LOCAL0` is the development exit gate, not release evidence. It uses the exact
fixture entrypoints, mounts, acquisition map, candidate-shaped inventory,
predecessor capsules, and receipt verifier that pre-tag P1 will use. Its first
diagnostic execution is serial so the first failed fixture and receipt survive.
It binds commit, tree, lockfile, artifact digest, compatibility inventory,
capsule digests, entrypoints, acquisition map, and acceptance-contract digest.
It proves the affected product predicates locally with substituted acquisition
classified as `SUPPORTING`; it cannot prove public acquisition, owner Local, or
real Hosting.

Run it through the single repository entrypoint:

```bash
bash scripts/run-lifecycle-local0.sh --mode all
```

The driver builds or reuses one commit/tree/lockfile/descriptor-bound Linux-x64
artifact, runs diagnostic lanes serially, then runs the complete lanes
concurrently against those same bytes. For a correction after a failure, use
`--mode serial --lane <failed-lane>`; that focused receipt is diagnostic and
does not replace the later complete receipt.

Do not reserve or write the next RC version, dispatch PRE-CANDIDATE, or create a
version-only PR until `LOCAL0` passes completely. Any change to a bound input or
to installer/bootstrap/lifecycle/signer bytes, archive handling, artifact
inventory, descriptor, generation ownership, capsule creation, fixture
transport, acceptance scripts/receipts, or release workflows invalidates the
whole receipt. Rebuild once when product bytes change. On failure, preserve the
first fixture and bounded diagnostics, correct locally, and rerun there; never
allocate another RC to discover whether the correction works.

PRE-CANDIDATE verifies frozen dependencies, production audit, release/package
identity, compatibility inventory, and public acquisition inputs. It must not
discover a new product command or product predicate. It accepts an exact merged
main only when its tree, lockfile, and bound release-contract inputs match the
green `LOCAL0` receipt.

The pre-tag P1 uses the exact Local and Hosting fixture entrypoints, container
mount layout, acquisition URL map, candidate-shaped artifact inventory, and
receipt verifier used after tagging. It runs on the same protected Linux runner
class. A tag is forbidden when any supported topology, executable fixture,
artifact name, transport route, or acceptance predicate has not executed
there. A recognized healthy pre-bootstrap managed control plane uses the
verified installer once for in-place takeover, followed by an installed-updater
`Already current` proof. Ambiguous, damaged, or incompatible state uses the
explicit repair route. Neither path becomes a target-tag-dependent ordinary
updater lane.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names/sizes/digests, provenance, SBOM/VEX, signer/controller identity,
and acceptance-contract identity. Build each supported target once. Publication
downloads and verifies those bytes; it never rebuilds.

P1 covers fresh protected Local, every materially distinct supported public
topology, rollback/retry, restart, declared-state preservation,
product/service health, and `Already current`. Independent topology lanes run
concurrently and consume the same candidate artifact. Literal owner Local
acceptance remains a post-publication machine check, not a version-selected
compatibility branch.

Product failure returns to one normal fix. Freeze candidate allocation, close
the failure through a new complete `LOCAL0` receipt, and require exact
merged-main PRE-CANDIDATE before assigning a new immutable identity.
Infrastructure failure may retry the failed job once against unchanged bytes.

Once source changes after an immutable tag, mark that candidate obsolete. Its
tag and bytes remain immutable, but it cannot be repaired, rebuilt, republished,
or used for owner acceptance. Allocate the next unused version only after the
corrected branch paths and exact merged-main PRE-CANDIDATE pass.

## Publication and acceptance

```text
GitHub prerelease exact bytes
-> signed beta channel advancement from those exact bytes
-> PUBLIC0 readback
-> owner Local
-> real Hosting
-> stable promotion
```

Publication makes the exact release public before advancing its channel. The
channel publisher consumes the exact attested index, rejects replay/downgrade,
stages replacement pairs, promotes their canonical names, and verifies
readback; it never rebuilds. Channel discovery also requires the current
36-hour attested root-head witness. The scheduled protected-main refresh may
replace only that witness and its attestation; it must verify the committed
root chain and current attested index and may never replace product bytes.
PUBLIC0 is readback-only. It verifies the exact GitHub tag, release
metadata, asset inventory, sizes, digests, attestations, root-head freshness,
and signed channel binding. Owner Local uses the literal public
command and proves four services, Wallet/signer, Mining, Network, plugins,
restart, preserved state, and `Already current`. Real Hosting requires an
authorized VPS/Tailscale environment; containers are supporting evidence only.

Stable promotion reuses accepted candidate bytes and changes only authorized
GitHub release/channel metadata.

## Authority

Do not create, move, delete, publish, or promote versions/tags/releases without
the current explicit authority. Never bypass protected checks or environment
review.

When the owner has explicitly authorized the sequence through publication,
submit that existing approval as soon as every immutable P1 lane passes. Do not
ask for the same approval again, weaken the environment, or allow the workflow
to self-approve. A failed or incomplete P1 cancels that publication action.
Never publish npm packages or make npm registry state a release predicate.
