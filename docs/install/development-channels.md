---
summary: "Stable, beta, and dev channels: semantics, switching, and tagging"
read_when:
  - You want to switch between stable/beta/dev
  - You are tagging or publishing prereleases
title: "Development Channels"
---

# Development channels

Fased ships three update channels for repo-backed updates and future package
publication:

- **stable**: latest stable release tag for git checkouts; `latest` package
  dist-tag after public package publication.
- **beta**: beta release tag for git checkouts; `beta` package dist-tag after
  public package publication.
- **dev**: developer channel for moving head of `main` (git); `dev` package
  dist-tag only when explicitly published.

<Note>
The current public install path is repo-backed. Package dist-tags are
release-maintainer context until public package publication is active.
</Note>

Maintainers ship builds to **beta**, test them, then **promote a vetted build to
stable/latest** without changing the version number. Public users should use
`fased update`, not direct package-manager commands.

## Switching channels

Git checkout:

```bash
fased update --channel stable
fased update --channel beta
fased update --channel dev
```

- `stable`/`beta` check out the latest matching tag (often the same tag).
- `dev` switches to `main` and rebases to the latest upstream commit only.
  Use `fased update --channel dev --safe-fallback` only for repair/debug
  sessions that should try older commits if latest `main` fails preflight.

`git pull --ff-only origin main` is a development flow, not a stable release
update. The stable end-user path is `fased update`, which lands on a release
tag. Current development fixes become available to stable users only after a new
stable tag or package release is published.

Future package/global install:

```bash
fased update --channel stable
fased update --channel beta
fased update --channel dev
```

This is package-release context for maintainers and future public package
installs. The current public setup path remains the repo-backed installer.

When you **explicitly** switch channels with `--channel`, Fased also aligns
the install method:

- `dev` ensures a git checkout (default `~/fased`, override with `FASED_GIT_DIR`),
  updates it, and installs the global CLI from that checkout.
- `stable`/`beta` can install from package dist-tags after public package
  publication is active.

Tip: if you want stable + dev in parallel, keep two clones and point your
gateway at the stable one.

## Plugins and channels

When you switch channels with `fased update`, Fased also syncs plugin sources:

- `dev` prefers bundled plugins from the git checkout.
- `stable` and `beta` restore npm-installed plugin packages.

## Tagging best practices

- Tag releases you want git checkout users to receive through `fased update`
  (`vX.Y.Z` or another stable `v*` tag for stable, `vX.Y.Z-beta.N` for beta).
- `vYYYY.M.D.beta.N` is also recognized for compatibility, but prefer `-beta.N`.
- Legacy `vYYYY.M.D-<patch>` tags are still recognized as stable (non-beta).
- Keep tags immutable: never move or reuse a tag.
- npm dist-tags remain the source of truth for npm installs:
  - `latest` → stable
  - `beta` → candidate build
  - `dev` → main snapshot (optional)

## macOS app availability

Beta and dev builds may **not** include a macOS app release. That’s OK:

- The git tag and npm dist-tag can still be published.
- Call out “no macOS build for this beta” in release notes or changelog.
