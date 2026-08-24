# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Candidate

Start from one clean exact protected-main commit. Finish the normal fix path and
focused source proof before release work begins.

```text
focused changed-surface checks
-> protected source PR and exact merged tree
-> version-only protected PR
-> prepare on protected main
   -> derive the next signed channel sequence
   -> build one unpublished Linux-x64 artifact and record its exact identity
-> owner creates the annotated tag at that prepared commit
-> finalize from the actual immutable tag ref
   -> download and verify the prepared artifact without rebuilding
   -> generate official attestations whose certificate SAN names the tag
   -> run the production bootstrap/trust verifier on the complete staged set
   -> publish those exact bytes and advance the signed channel
```

Do not write the next RC version or start preparation until focused source
checks pass. Never use successive RC names to diagnose source behavior: one
version-only PR creates the exact identity needed to prepare unpublished bytes.
Any product change after preparation invalidates the artifact and returns to the
normal fix path.

Preparation derives the next release sequence from the current signed channel index
instead of accepting an operator-supplied sequence. It installs dependencies once,
builds one Linux-x64 core artifact, and never runs simulated Local or Hosting
acceptance. Build optional packs separately through their signed component
transaction.

The candidate descriptor binds version, commit, tree, lockfile, prepare run,
artifact names, sizes and digests, provenance, SBOM/VEX, signer/controller identity,
and the acceptance-contract identity. The owner creates the annotated tag only
after preparation passes. Finalization must verify the prepared descriptor and
execute with its actual `GITHUB_REF` equal to
`refs/tags/v<version>`; checking out the tag inside a branch-triggered run does not
change the certificate identity. It downloads and verifies the prepared artifact,
requires every official attestation's `SourceRepositoryRef` to equal that tag and
`SourceRepositoryDigest` to equal the peeled tag commit, and never rebuilds.

Before public mutation, run the same production bootstrap/trust verification used by
the installer against the complete staged artifact set. Static workflow assertions,
unit-only bundle parsing, signed-channel promotion, and same-commit branch attestations
cannot substitute for this check. Any official release bundle carrying
`refs/heads/main` fails closed even when its commit is identical.

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

## Publication and owner-controlled acceptance

```text
GitHub prerelease exact bytes
-> signed beta channel advancement from those exact bytes
-> PUBLIC0 readback
-> stable promotion
```

PUBLIC0 is readback-only. It verifies the exact GitHub tag, release metadata,
asset inventory, sizes, digests, attestations, root-head freshness, and signed
channel binding. It does not provide Local or Hosting acceptance.

Fresh Local and Hosting evidence is owner-supplied only. Never create or
simulate a fresh machine. Codex may update the existing owner-Local installation
only with explicit authority. A fresh Local command is run by the owner; Hosting
is tested only when the owner provides or authorizes a reachable VPS.

These checks never block ordinary fixes or RC publication by default. When the
owner explicitly selects acceptance or stable promotion requires it, the
receipt binds `version`, exact `commit`, exact `tree`, `prepareRunId`, and the
complete `artifactSetSha256`, plus the environment, exact public commands and
outcomes. Containers, generated VMs, and substituted fixtures are `SUPPORTING`,
never `PASS`.

Stable promotion reuses accepted candidate bytes and changes only authorized
GitHub release/channel metadata.

## Authority

Do not create, move, delete, publish, or promote versions, tags, or releases
without current explicit authority. Never bypass protected checks or environment
review. One approval may authorize a named conditional chain; do not ask for the
same approval again while its exact identities and predicates remain unchanged.

Never publish npm packages or make npm registry state a release predicate.
