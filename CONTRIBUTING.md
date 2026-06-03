# Contributing to Fased

Thanks for contributing to `fased-ai/fased`.

This repository is the public codebase for the Fased product surface:

- gateway and CLI
- control UI
- apps and nodes
- public extensions and plugin SDK
- public product docs

Related public-release/legal files:

- [LICENSE](LICENSE)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [DISCLAIMER.md](DISCLAIMER.md)
- [PLUGIN_LICENSE_POLICY.md](PLUGIN_LICENSE_POLICY.md)

## Before You Start

Small fixes are welcome as direct pull requests.

For larger changes, start with an issue first if the change affects:

- onboarding or hosting behavior
- wallet, federation, or mining behavior
- plugin or SDK contracts
- public product positioning
- release or install flows

Use the issue to state:

- the problem
- the proposed approach
- the user or operator impact
- any migration risk

## What Stays Public vs Private

Public here:

- this repository
- public docs, examples, and install flows
- public extension code and plugin SDK

Do not send public PRs for:

- secrets or deploy credentials
- private keys, signer material, or seed material
- private operational runbooks or abuse-response notes
- exploit details that should not be posted publicly yet

If you are not sure whether something belongs here, open an issue first.

## Development Setup

Runtime:

- Node `>=22.12.0`
- `pnpm` preferred

Typical setup:

```bash
pnpm install
pnpm ui:build
pnpm build
```

Common commands:

```bash
pnpm build
pnpm check
pnpm test
pnpm check:docs
pnpm gateway:watch
```

If your change only touches docs, run:

```bash
pnpm check:docs
```

If your change only touches the UI, also run:

```bash
pnpm test:ui
```

## Contribution Rules

Keep PRs focused.

Good:

- one bug fix
- one feature slice
- one docs cleanup
- one refactor with a clear boundary

Bad:

- unrelated bug fixes bundled together
- product behavior change plus broad cleanup plus style churn
- undocumented onboarding or config changes

## Required Docs Updates

If your PR changes user or operator behavior for any of these:

- onboarding
- hosting profiles
- wallets
- federation
- mining
- plugins
- public domains or docs structure

then update the matching docs in the same PR.

Source of truth:

- `docs/` in this repository = public Fased product docs

## Pull Request Expectations

Every non-trivial PR should explain:

- what changed
- why it changed
- what user or operator behavior changed
- what did not change
- what checks you ran
- what docs changed

If the change is visual, include screenshots.

If the change affects runtime or security-sensitive behavior, call out rollback or disable steps.

## Attribution And Credits

This repo keeps legally required third-party and copied-code attribution where it applies.

Contributor recognition for Fased is handled through:

- git history
- pull requests and releases
- targeted credits docs where still useful

We do not use the README as a permanent credits page.

If your change copies or vendors third-party code, data, or assets, include the
required notice updates in the same PR.

If your change introduces a finance, crypto, trading, or news-related surface, add
or update the matching risk/disclaimer docs too.

## AI-Assisted Contributions

AI-assisted PRs are allowed.

Be explicit:

- say the PR was AI-assisted
- describe how much you personally reviewed and tested
- do not submit code you do not understand

Review quality matters more than how the patch was produced.

## Tests And Verification

Run the smallest honest set of checks that matches your change.

Examples:

- docs-only: `pnpm check:docs`
- UI change: `pnpm test:ui`
- gateway or CLI change: `pnpm build && pnpm check && pnpm test`

If you could not run an expected check, say so clearly in the PR.

## Security Reports

Use [SECURITY.md](SECURITY.md).

Short version:

- use GitHub issues for most security bugs and hardening reports
- do not publish secrets, private infra details, or live exploit material
- if the report cannot be shared publicly, open a minimal issue and ask for a private handoff

## Maintainer Model

This project accepts outside contributions, but final merge authority stays centralized.

Current policy:

- contributors can open issues and PRs
- maintainers review for correctness, security, migration risk, and docs impact
- the owner remains the final approver for releasable state

## Plugin Licensing

Standalone plugins may use their own licenses when they are genuinely separable from
the Fased core and preserve any copied-code obligations.

See:

- [PLUGIN_LICENSE_POLICY.md](PLUGIN_LICENSE_POLICY.md)

## Release Surfaces

Maintainer-facing release docs:

- [RELEASING.md](RELEASING.md)
- [RELEASE_NOTES_TEMPLATE.md](RELEASE_NOTES_TEMPLATE.md)

Use those when a PR changes anything release-sensitive.
