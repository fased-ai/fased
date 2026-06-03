---
title: CI Pipeline
description: How the Fased CI pipeline works
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only docs or native code changed.

## Job Overview

| Job               | Purpose                                         | When it runs              |
| ----------------- | ----------------------------------------------- | ------------------------- |
| `docs-scope`      | Detect docs-only changes                        | Always                    |
| `changed-scope`   | Detect which areas changed (node/macos/android) | Non-docs PRs              |
| `check`           | TypeScript types, lint, format                  | Non-docs changes          |
| `check-docs`      | Markdown lint + broken link check               | Docs changed              |
| `code-analysis`   | LOC threshold check (1000 lines)                | PRs only                  |
| `secrets`         | Detect leaked secrets                           | Always                    |
| `build-artifacts` | Build dist once, share with other jobs          | Non-docs, node changes    |
| `release-check`   | Validate npm pack contents                      | After build               |
| `checks`          | Node/Bun tests + protocol check                 | Non-docs, node changes    |
| `checks-windows`  | Windows-specific tests                          | Non-docs, node changes    |
| `macos`           | Swift lint/build/test + TS tests                | PRs with macos changes    |
| `android`         | Gradle build + tests                            | Non-docs, android changes |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `docs-scope` + `code-analysis` + `check` (parallel, ~1-2 min)
2. `build-artifacts` (blocked on above)
3. `checks`, `checks-windows`, `macos`, `android` (blocked on build)

## Runners

| Runner                           | Jobs                                       |
| -------------------------------- | ------------------------------------------ |
| `blacksmith-16vcpu-ubuntu-2404`  | Most Linux jobs, including scope detection |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                           |
| `macos-latest`                   | `macos`, `ios`                             |

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm test           # vitest tests
pnpm check:docs     # docs format + lint + broken links
pnpm release:check  # validate npm pack
```

## Strict TypeScript Baseline

`pnpm check:strict` still runs the full native TypeScript check with `pnpm tsgo`.
It is intentionally left as the repo-wide truth source, even while older strict
debt remains in unrelated areas.

Use these helper gates while the repo-wide cleanup is in progress:

```bash
pnpm check:strict:baseline
pnpm check:strict:scoped
```

`check:strict:baseline` writes the current full output and grouped summary under
`.artifacts/strict/`. It is a reporting command and does not hide failures.

`check:strict:scoped` also runs `pnpm tsgo`, but it fails only when strict errors
appear in the wallet, Marketplace, mining, and recently touched UI/tool files.
This gives those lanes a usable no-regression gate while older ACPX, ACP spawn,
config/debug UI, SDK typing, and other repo-wide strict buckets are cleaned in
separate commits.
