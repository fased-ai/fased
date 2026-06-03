# Releasing Fased

This is the maintainer-facing entrypoint for releases.

Use it together with the detailed product release checklist in:

- [docs/reference/RELEASING.md](docs/reference/RELEASING.md)

## Release rule

Do not cut a release from memory.

Use the written checklist and confirm:

- build passes
- checks and tests are honest for the scope
- docs match runtime behavior
- release notes are written before publishing

## What version, tag, release, and appcast mean

- `package.json` version = the repo/application version
- `CHANGELOG.md` = curated human release notes history
- Git tag = the source snapshot for a release
- GitHub release = published release page and artifacts
- `appcast.xml` = macOS Sparkle auto-update feed only
- native signer binaries = release artifacts built from `tools/fased-signerd`,
  not files committed to the source tree

Those are related, but they are not the same thing.

## Minimum release flow

1. merge approved work into `main`
2. run release validation
3. update `CHANGELOG.md`
4. draft release notes from [RELEASE_NOTES_TEMPLATE.md](RELEASE_NOTES_TEMPLATE.md)
5. cut tag and publish the GitHub release when artifacts are real
6. verify install and docs after publish

## When release notes must call something out

Always call out:

- onboarding or hosting changes
- wallet or signer changes
- federation changes
- mining changes
- config or env changes
- breaking defaults

## Related files

- [CHANGELOG.md](CHANGELOG.md)
- [RELEASE_NOTES_TEMPLATE.md](RELEASE_NOTES_TEMPLATE.md)
- [docs/reference/RELEASING.md](docs/reference/RELEASING.md)
