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
-> focused changed-surface checks
-> protected source PR with byte-identical squash tree
-> affected real-environment proof on exact merged source
-> PRE-CANDIDATE on exact merged main
-> version-only protected PR
-> build one production Linux-x64 artifact on exact versioned main
-> P1 verifies that artifact, provenance and bound real-environment receipts
-> owner immutable proof-enabling tag at exact main
-> attest the preserved product bytes without rebuilding or executing them
-> protected publication approval
```

Do not reserve or write the next RC version, dispatch PRE-CANDIDATE, or create a
version-only PR until the required focused checks and affected real-environment
predicates pass. Any change to a bound product input invalidates the artifact;
rebuild once after source is final. A harness-only change may reuse unchanged
bytes only when the complete product tree and lockfile remain exact. Never
allocate an RC to discover whether a correction works.

Before PRE-CANDIDATE, run `scripts/pre-candidate-readiness.mjs` locally against
the exact real Hosting staging receipt when Hosting is affected. Produce that
receipt only with
`scripts/hosting-staging-vps-receipt.mjs` after the literal 2 GB/no-swap staging
VPS install and identical-command `Already current` proof. It rejects a dirty or mismatched source,
missing fresh-login `fased` command evidence, missing `Already current`, an
unresolved exact-source failure marker, or an unavailable exact predecessor
release. Its receipt digest is a required PRE-CANDIDATE input and evidence
field.

PRE-CANDIDATE is metadata-only. It verifies release/package identity,
compatibility inventory and the exact real-environment receipt. It does not
install dependencies, build bytes or execute an installation.

P1 installs frozen dependencies once, builds the Linux-x64 product once, and
verifies artifact, provenance, compatibility and the bound real-environment
receipt. It does not run a protected-Local container or repeat packaged Hosting
execution. Build optional packs separately through their signed component
transaction; the base candidate contains only the core inventory.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names/sizes/digests, provenance, SBOM/VEX, signer/controller identity,
and acceptance-contract identity. After the proof-enabling tag, publication
downloads that exact artifact, verifies its descriptor and checksum, adds only
tag-scoped attestations and signed release metadata, and publishes. It neither
rebuilds nor replays P1. Literal owner Local remains a post-publication
owner-machine check using the documented curl, `fased status`, and
`fased update` commands.

Product failure returns to one normal fix. Freeze candidate allocation, close
the failure in its exact affected environment, and require exact merged-main
PRE-CANDIDATE before assigning a new immutable identity.
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
