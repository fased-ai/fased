---
summary: "License, third-party notices, risk disclosure, and release boundaries."
read_when:
  - You are preparing a release
  - You need the legal and risk document map
title: "Legal and Risk"
---

# Legal and Risk

This page is the short map for the Fased legal, notice, and risk-disclosure surface.

## Core files

- [`LICENSE`](https://github.com/fased-ai/fased/blob/main/LICENSE)
- [`SECURITY.md`](https://github.com/fased-ai/fased/blob/main/SECURITY.md)
- [`THIRD_PARTY_NOTICES.md`](https://github.com/fased-ai/fased/blob/main/THIRD_PARTY_NOTICES.md)
- [`docs/legal/disclaimer.md`](https://github.com/fased-ai/fased/blob/main/docs/legal/disclaimer.md)
- [`CONTRIBUTING.md`](https://github.com/fased-ai/fased/blob/main/CONTRIBUTING.md)
- [`docs/reference/plugin-license-policy.md`](https://github.com/fased-ai/fased/blob/main/docs/reference/plugin-license-policy.md)

## What each file is for

### `LICENSE`

The repository license for the core codebase.

For this repo, that includes preserved attribution for MIT-licensed code where
required plus a separate modification notice for Fased work.

### `THIRD_PARTY_NOTICES.md`

Repository-level map of bundled third-party code, fonts, data, and notice files that
must stay preserved when the repo is published or redistributed.

### `SECURITY.md`

Public repository security-reporting policy and trust-boundary summary for the
current self-hosted runtime model.

### `docs/legal/disclaimer.md`

Product-specific risk clarification for:

- wallets
- crypto
- mining
- Fased Network
- operator roles
- reviewed wallet actions
- news / market-intelligence features

This is where "not financial advice" belongs, not inside the repository license.

### `CONTRIBUTING.md`

Contribution rules, maintainer expectations, attribution expectations, and what a PR
must update when it changes user or operator behavior.

### `docs/reference/plugin-license-policy.md`

Rules for when standalone plugins may carry their own license and what happens when a
plugin copies or vendors third-party code.

## Release rule of thumb

Before making claims about a feature being ready for production wallet use,
external routing, or unattended operation, separate these clearly:

- read-only preview
- gated but implemented
- live and approved

That distinction matters more for Fased than for a generic chat tool because the repo
already includes wallet, mining, Fased Network, and operator trust surfaces.
