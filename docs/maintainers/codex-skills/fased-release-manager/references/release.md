# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact protected-main commit. Finish the normal fix path and
the literal affected-environment proof before release work begins.

```text
focused changed-surface checks
-> protected source PR and exact merged tree
-> affected real-environment proof when the change requires it
-> version-only protected PR
-> one protected release workflow
   -> derive the next signed channel sequence
   -> build one Linux-x64 artifact
   -> attest that artifact
   -> create one immutable tag
   -> publish those exact bytes
   -> advance the signed channel
```

Do not write the next RC version or start the release workflow until required
focused checks and the affected real-environment predicate pass. Any product
change after that proof returns to the normal fix path. Never allocate an RC to
discover whether a correction works.

One protected workflow builds, attests, tags, publishes, and promotes. It derives
the next release sequence from the current signed channel index instead of
accepting an operator-supplied sequence. It installs dependencies once, builds
one Linux-x64 core artifact, and never runs simulated Local or Hosting acceptance.
Build optional packs separately through their signed component transaction.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names, sizes and digests, provenance, SBOM/VEX, signer/controller
identity, and the acceptance-contract identity. The publish job downloads the
single job artifact, verifies it, creates or confirms the exact annotated tag,
and publishes without rebuilding.

If source changes after an immutable tag, that candidate is obsolete. Its tag
and bytes remain immutable. Fix and merge normally, prove the affected real
environment, and choose the next unused version.

## Fast publication retry

If the release and attestations already exist but channel advancement failed,
run only `Hosted Runtime Promote`. It downloads bounded public metadata, verifies
the existing tag, descriptor, attestations, inventory, and signed index, then
advances or confirms the channel. It does not install dependencies, build,
reattest, create a candidate, or rerun acceptance.

Do not rerun the full release workflow after the immutable public release exists.
An identical promotion retry must return `ALREADY_CURRENT`.

## Publication and acceptance

```text
GitHub prerelease exact bytes
-> signed beta channel advancement from those exact bytes
-> PUBLIC0 readback
-> owner Local
-> real Hosting
-> stable promotion
```

PUBLIC0 is readback-only. It verifies the exact GitHub tag, release metadata,
asset inventory, sizes, digests, attestations, root-head freshness, and signed
channel binding. It does not provide Local or Hosting acceptance.

Owner Local uses only the documented public curl command, `fased status`, and
`fased update`. Real Hosting uses only an authorized real VPS and the documented
public command; containers, generated VMs, and substituted fixtures are
`SUPPORTING`, never `PASS`.

Stable promotion reuses accepted candidate bytes and changes only authorized
GitHub release/channel metadata.

## Authority

Do not create, move, delete, publish, or promote versions, tags, or releases
without current explicit authority. Never bypass protected checks or environment
review. One approval may authorize a named conditional chain; do not ask for the
same approval again while its exact identities and predicates remain unchanged.

Never publish npm packages or make npm registry state a release predicate.
