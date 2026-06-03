---
summary: "Community plugins: quality bar, hosting requirements, and PR submission path"
read_when:
  - You want to publish a third-party Fased plugin
  - You want to propose a plugin for docs listing
title: "Community plugins"
---

# Community plugins

This page tracks high-quality **community-maintained plugins** for Fased.

We accept PRs that add community plugins here when they meet the quality bar.

## Required for listing

- Plugin package is published on npmjs (installable via `fased plugins install <npm-spec>`).
- Source code is hosted on GitHub (public repository).
- Repository includes setup/use docs and an issue tracker.
- Plugin has a clear maintenance signal (active maintainer, recent updates, or responsive issue handling).

## How to submit

Open a PR that adds your plugin to this page with:

- Plugin name
- npm package name
- GitHub repository URL
- One-line description
- Install command

## Review bar

We prefer plugins that are useful, documented, and safe to operate.
Low-effort wrappers, unclear ownership, or unmaintained packages may be declined.

## Candidate format

Use this format when adding entries:

- **Plugin Name** — short description
  npm: `@scope/package`
  repo: `https://github.com/org/repo`
  install: `fased plugins install @scope/package`

## Listed plugins

No community plugin is listed here by default. Add entries only after the package
name, source repository, maintenance status, and user-facing setup guide have
been reviewed.
