---
title: "Release Checklist"
summary: "Current Fased release flow: version bump, changelog, Git tag, GitHub release, and optional macOS appcast."
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

Today the public release model is:

- curl bootstrap install for beginner/local/fresh VPS setup
- annotated Git tag + GitHub release for user-installable snapshots
- optional macOS Sparkle/appcast if a signed desktop build is being shipped

The beginner install path should stay curl-first because it can install missing
OS tools, Git, Node, and pnpm:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash
```

Do not add public package-manager install commands until the package is
published, installed on a clean test machine, and verified end to end.

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

2. **Build**

- [ ] `pnpm build`
- [ ] `pnpm ui:build`
- [ ] run the smallest honest validation set for the scope

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

- [ ] merge approved work into `main`
- [ ] make sure the worktree is clean
- [ ] commit the version/changelog/docs updates
- [ ] push `main`
- [ ] create an annotated tag on the pushed release commit
- [ ] push the branch and tag

Typical shape:

```bash
git checkout main
git pull --rebase
pnpm build
git add .
git commit -m "chore(release): cut vX.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "Fased Agent vX.Y.Z"
git push origin vX.Y.Z
```

Verify the tag points at the release commit:

```bash
git rev-parse HEAD
git rev-list -n 1 vX.Y.Z
```

Those two commit SHAs should match.

## GitHub release

- [ ] create the GitHub release for `vX.Y.Z`
- [ ] attach real artifacts only
- [ ] paste the curated release notes into the release body
- [ ] do not claim package-manager install paths that are not actually supportable yet

CLI shape:

```bash
gh release create vX.Y.Z \
  --repo fased-ai/fased \
  --title "Fased Agent vX.Y.Z" \
  --notes-file /tmp/fased-release-notes.md
```

For a short hotfix release, inline notes are acceptable:

```bash
gh release create vX.Y.Z \
  --repo fased-ai/fased \
  --title "Fased Agent vX.Y.Z" \
  --notes "Installer hotfix for ..."
```

Verify:

```bash
gh release view vX.Y.Z --repo fased-ai/fased --web
```

## Hotfix and mistake policy

- If a tag was created but no GitHub release exists yet, create the GitHub
  release for that tag.
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
