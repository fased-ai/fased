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

## Current public release model

Today the public release model is:

- repo-backed install
- Git tag + GitHub release when artifacts are ready
- optional macOS Sparkle/appcast if a signed desktop build is being shipped

Public npm publication is not the default release surface yet.

## Version vs tag vs release vs appcast

- `package.json` version = the repo/application version
- `CHANGELOG.md` = curated human release history
- Git tag = the source snapshot for a release
- GitHub release = the published release page and attached artifacts
- `appcast.xml` = the macOS Sparkle update feed only

Changing one of these does not automatically update the others.

## Preflight

1. **Version**

- [ ] bump `package.json` version
- [ ] make sure version-sensitive UI/app strings match when needed

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
- [ ] draft the GitHub release body from [RELEASE_NOTES_TEMPLATE.md](https://github.com/fased-ai/fased/blob/main/RELEASE_NOTES_TEMPLATE.md)

Important:

- commits and PR merges do **not** generate release notes automatically
- changelog and GitHub release text are still maintainer-written surfaces

## Git flow

- [ ] merge approved work into `main`
- [ ] make sure the worktree is clean
- [ ] commit the version/changelog/docs updates
- [ ] create the tag
- [ ] push the branch and tag

Typical shape:

```bash
git checkout main
git pull --rebase
pnpm build
git add .
git commit -m "chore(release): cut vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## GitHub release

- [ ] create the GitHub release for `vX.Y.Z`
- [ ] attach real artifacts only
- [ ] paste the curated release notes into the release body
- [ ] do not claim package-manager install paths that are not actually supportable yet

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
- [`RELEASE_NOTES_TEMPLATE.md`](https://github.com/fased-ai/fased/blob/main/RELEASE_NOTES_TEMPLATE.md)
- [`RELEASING.md`](https://github.com/fased-ai/fased/blob/main/RELEASING.md)
