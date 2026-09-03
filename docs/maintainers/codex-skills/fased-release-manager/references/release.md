# Candidate and Release

Read this file only after explicit candidate, publication, or stable authority.

## Fix and release

When the owner says “fix and release,” treat it as one conditional chain:

```text
focused changed-surface checks
-> one protected PR containing the fix and next unused version
-> squash merge the exact passing head
-> owner-authorized annotated tag at that merged commit
-> one tag-bound release workflow
   -> derive the next signed channel sequence
   -> build Linux-x64 once
   -> attest and verify those exact bytes
   -> publish and advance the signed channel
-> public release readback
```

The fix and version share one review and one changed-surface CI run. After merge,
the owner-authorized annotated tag selects the exact commit. The workflow runs
from that tag, installs frozen dependencies once, builds one Linux-x64 core
artifact, and performs publication in the same run. Optional component packs use
their signed component transaction.

The default release topology is exactly one Linux-x64 publication job. It does
not start, await, or download Linux ARM64 or macOS build jobs. Cross-platform
support is not permission to expand this default. A portable or multi-platform
release uses a separate owner-requested workflow and is never selected implicitly
for an ordinary fix, RC, tag, or publication.

Reserve the unused version before delivery and change it in the product-fix PR.
Do not merge a release-authorized product fix and then create a standalone
version PR. After the nearest regression passes, do not add a full-package rerun.
The protected owner-created annotated tag is the approval for the initial
tag-bound publication workflow, so that workflow has no second environment-review
pause. pnpm and Go caches plus parallel signer/lifecycle compilation remain
enabled; cache hits may accelerate compilation but never replace tag-bound
assembly, verification, attestation, or publication.

Build Linux-x64 once per new public version. The installer consumes compiled
Gateway assets and native signer/lifecycle binaries whose manifest and
attestations bind the exact version, commit, tree, and artifact digest, so a prior
version's assembled artifact is not reusable. Cache the pnpm store and Go build
outputs by their lockfiles and toolchain; do not add another platform build or a
second Linux build to improve confidence.

The candidate descriptor binds version, commit, tree, lockfile, workflow run,
artifact names, sizes and digests, provenance, SBOM/VEX, signer/controller identity,
and the acceptance-contract identity. The release workflow executes with its
actual `GITHUB_REF` equal to
`refs/tags/v<version>`; checking out the tag inside a branch-triggered run does not
change the certificate identity. It builds and verifies the exact artifact in that
same run, requires every official attestation's `SourceRepositoryRef` to equal the tag and
`SourceRepositoryDigest` to equal the peeled tag commit, and never rebuilds.

Before public mutation, run the same production bootstrap/trust verification used by
the installer against the complete staged artifact set. Static workflow assertions,
unit-only bundle parsing, signed-channel promotion, and same-commit branch attestations
cannot substitute for this check. Any official release bundle carrying
`refs/heads/main` fails closed even when its commit is identical.

If the tag-bound workflow fails before publication, fix the reported predicate
in one new protected PR and use the next unused immutable version. A publication
retry for an already existing release uses the metadata-only promotion workflow.

## Fast publication retry

If the release and attestations already exist but channel advancement failed,
run only `Hosted Runtime Promote`. It downloads bounded public metadata, verifies
the existing tag, descriptor, attestations, inventory, and signed index, then
advances or confirms the channel. It does not install dependencies, build,
reattest, create a candidate, or rerun acceptance.

An identical promotion retry returns `ALREADY_CURRENT`.

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

The owner initiates fresh Local and Hosting checks after publication. Codex may
update the existing owner-Local installation with explicit authority, accept
literal output from the owner's fresh Local machine, or connect to a VPS the
owner provides. An acceptance receipt, when requested, binds the public version,
commit, tree and artifact-set digest.

Stable promotion reuses accepted candidate bytes and changes only authorized
GitHub release/channel metadata.

## Authority

Do not create, move, delete, publish, or promote versions, tags, or releases
without current explicit authority. Never bypass protected checks. The initial
publication uses the protected owner-created annotated tag as its approval;
metadata-only promotion retains its configured environment review. One approval
may authorize a named conditional chain; do not ask for the same approval again
while its exact identities and predicates remain unchanged.

## GitHub authentication

Before the first GitHub API mutation, run `gh auth status`. Reuse a valid saved
credential without asking the owner to authenticate again. If the saved
credential is absent or invalid and the authorized workflow requires GitHub API
access, start exactly one device flow with automatic browser opening disabled,
show the owner the one-time code and `https://github.com/login/device`, and keep
that same flow alive while the owner authorizes it. Afterward, require
`gh auth status` to prove the credential was saved before continuing. Never
start parallel or repeated device flows, never merely tell the owner to “log
in,” and never expose the resulting token.

Never publish npm packages or make npm registry state a release predicate.
