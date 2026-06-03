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

- [`LICENSE`](https://github.com/fased-ai/agent/blob/main/LICENSE)
- [`SECURITY.md`](https://github.com/fased-ai/agent/blob/main/SECURITY.md)
- [`THIRD_PARTY_NOTICES.md`](https://github.com/fased-ai/agent/blob/main/THIRD_PARTY_NOTICES.md)
- [`DISCLAIMER.md`](https://github.com/fased-ai/agent/blob/main/DISCLAIMER.md)
- [`CONTRIBUTING.md`](https://github.com/fased-ai/agent/blob/main/CONTRIBUTING.md)
- [`PLUGIN_LICENSE_POLICY.md`](https://github.com/fased-ai/agent/blob/main/PLUGIN_LICENSE_POLICY.md)

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

### `DISCLAIMER.md`

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

### `PLUGIN_LICENSE_POLICY.md`

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
