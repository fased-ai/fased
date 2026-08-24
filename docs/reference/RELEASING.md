---
title: "Release Checklist"
summary: "Current Fased release flow: protected versioned change, annotated tag, one multi-platform build, and publication."
read_when:
  - Cutting a new public release
  - Verifying how version, tag, GitHub release, and appcast relate
  - Preparing release notes and artifacts
---

# Release Checklist

Use `pnpm` (Node 22+) from the repo root. Keep the working tree clean before
tagging or publishing anything.

This page is the maintainer source of truth for Fased Agent releases. Follow it
in order. Do not create a tag or GitHub release until the commit is the exact
installable snapshot users should receive.

## Current public release model

The public release model is:

- curl bootstrap install for managed Local and fresh VPS Hosting
- platform-qualified signed release artifacts for the managed runtime
- owner-created annotated Git tag selecting the immutable source snapshot
- one tag-bound workflow that builds, attests, publishes, and advances the channel
- optional macOS Sparkle/appcast if a signed desktop build is being shipped

The beginner install path stays curl-first. Managed users do not install Git,
Node, pnpm, or Go; the release bundles the application runtime and native
lifecycle services. The bootstrap may install bounded operating-system
prerequisites required by the selected profile:

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --local
```

The package name is `@fased/fased`, but public setup docs should keep pointing
users to the Fased installer so Local/VPS Hosting setup, Tailscale, service
management, and host hardening stay aligned.

## Version vs tag vs release vs appcast

- `package.json` version = the repo/application version
- `CHANGELOG.md` = curated human release history
- Git tag = the source snapshot for a release
- GitHub release = the published release page and attached artifacts
- `appcast.xml` = the macOS Sparkle update feed only

Changing one of these does not automatically update the others.

Normal releases should be sparse. Do not create a release for every small README
or docs cleanup. Use a new patch release only when `main` contains a user-facing
installer/runtime/docs fix that should become the current public snapshot.

The early `v0.1.1`, `v0.1.2`, and `v0.1.3` releases happened during initial
public-repo setup and installer hotfixing. Going forward, cut one release per
deliberate public snapshot.

## Remote and author check

Before a release, confirm you are pushing to the correct repository and with the
intended maintainer identity:

```bash
git remote -v
git config user.name
git config user.email
```

Expected repository:

```text
fased-ai/fased
```

Use a clean SSH or HTTPS remote. Do not store a GitHub token in the remote URL.
Examples:

```bash
git remote set-url origin git@github.com:fased-ai/fased.git
# or, if your machine uses an SSH host alias:
git remote set-url origin git@github-fased:fased-ai/fased.git
```

Expected release author identity for official maintainer pushes is the
maintainer account used by `fcode-ai`.

## Preflight

1. **Version**

- [ ] bump `package.json` version
- [ ] bump `src/brand.ts` `FASED_PRODUCT_VERSION`
- [ ] confirm no other release-version string needs changing:

```bash
rg -n '"version":|FASED_PRODUCT_VERSION|vX\.Y\.Z|X\.Y\.Z' package.json src docs README.md
```

Do not edit `pnpm-lock.yaml` only to change the root package version unless the
package manager changed it as part of a real dependency/install update.

2. **Focused validation**

- [ ] run the nearest regression and directly coupled contracts
- [ ] run changed-file formatting
- [ ] let protected changed-surface CI validate the exact PR head

Do not construct release artifacts before the immutable annotated tag exists.
The tag-bound workflow performs the one official build.

3. **Docs**

- [ ] update user/operator docs if behavior changed
- [ ] confirm install, update, wallet, Fased Network, mining, or bond docs still match reality

## Changelog and release notes

- [ ] update `CHANGELOG.md`
- [ ] keep it curated and human-readable
- [ ] use current Fased naming in new entries
- [ ] preserve older historical names in older entries instead of rewriting history
- [ ] draft the GitHub release body from
      [release-notes-template.md](https://github.com/fased-ai/fased/blob/main/docs/reference/release-notes-template.md)

Important:

- commits and PR merges do **not** generate release notes automatically
- changelog and GitHub release text are still maintainer-written surfaces

## Git flow

- [ ] reserve an unused version in the product PR
- [ ] merge the exact protected, passing PR head into `main`
- [ ] validate the merged commit and tree
- [ ] create and push an annotated tag on that merged commit
- [ ] dispatch Hosted Runtime Release from the actual tag ref
- [ ] wait for its single build/attest/publish/channel run
- [ ] read back the public tag, assets, attestations, and signed channel

Typical shape:

```bash
VERSION=X.Y.Z
COMMIT=<exact-merged-main-commit>
git tag -a "v$VERSION" "$COMMIT" -m "Fased Agent v$VERSION"
git push origin refs/tags/vX.Y.Z
gh workflow run hosted-runtime-release.yml \
  --repo fased-ai/fased \
  --ref "v$VERSION" \
  -f release_version="$VERSION" \
  -f source_commit="$COMMIT"
```

Verify the tag points at the release commit:

```bash
git rev-parse HEAD
git rev-list -n 1 vX.Y.Z
```

Those two commit SHAs should match.

## GitHub release and signed channels

The tag-bound workflow creates the GitHub prerelease and attaches only the
artifacts produced and attested by that run. Do not create a parallel manual
release or upload locally built artifacts.

It advances two predecessor-compatible channel documents with the same release
identity:

- v1 remains Linux-only so existing Linux bootstraps keep updating;
- v2 carries platform-qualified Linux and Darwin assets for current bootstraps.

The metadata schema is not a user-facing product version. Existing managed
users continue to run `fased update`; they do not reinstall to move from v1 to
v2 metadata.

Verify:

```bash
gh release view vX.Y.Z --repo fased-ai/fased --web
```

## Hotfix and mistake policy

- If a tag was created but publication failed before a GitHub release exists,
  fix the failed predicate in a protected PR and use the next unused version.
- If the release and attestations exist but only channel advancement failed,
  run the metadata-only promotion workflow; do not rebuild or retag.
- If a GitHub release is already public, do not move or rewrite its tag.
- If the released commit is missing an installer/runtime fix, make a new commit
  and cut the next patch version.
- If only docs/README changed after a release, normally leave `main` ahead of
  the latest release and wait for the next real release.
- Never force-push `main` or retag a published release unless the repository is
  still private, nobody has pulled it, and maintainers explicitly agree.

Example: if `v0.1.2` is public and the installer still has a prelaunch blocker,
fix it on `main`, bump to `v0.1.3`, tag `v0.1.3`, and create the `v0.1.3`
release. Do not move `v0.1.2`.

## Post-public repository hardening

- [ ] enable `main` branch protection once the repository is public or the
      organization plan supports private-repo protection
- [ ] block force pushes and branch deletion
- [ ] add required status checks after CI is stable for the public repo
- [ ] keep emergency admin bypass limited to maintainers who cut releases

## Optional: macOS app + appcast

If you are shipping a signed macOS desktop build:

- [ ] build and sign the app bundle
- [ ] zip the app for distribution
- [ ] generate `appcast.xml`
- [ ] make sure the feed URL is the real raw repo path:
  - `https://raw.githubusercontent.com/fased-ai/fased/main/appcast.xml`
- [ ] publish the release assets that the appcast points to

See [macOS release](/platforms/mac/release) for the exact commands.

## What does not happen automatically

These are separate maintainer actions:

- bumping `package.json` does not create a GitHub release
- merging PRs does not rewrite `CHANGELOG.md`
- tagging does not generate appcast artifacts by itself
- appcast only matters for the macOS Sparkle path

## Related files

- [`CHANGELOG.md`](https://github.com/fased-ai/fased/blob/main/CHANGELOG.md)
- [Release notes template](/reference/release-notes-template)
- [Releasing](/reference/RELEASING)
