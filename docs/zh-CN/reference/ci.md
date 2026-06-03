---
title: CI Pipeline
description: Fased CI pipeline 如何工作
summary: "CI job graph、scope gates 和本地等价命令"
read_when:
  - 你要理解 CI job 为什么运行或跳过
  - 你在调试 GitHub Actions checks
---

# CI Pipeline

CI 在每次 push 到 `main` 和每个 pull request 上运行。它使用 scope detection，在 docs-only 或 native-only 改动时跳过昂贵 jobs。

## Job overview

| Job               | Purpose                           | When it runs           |
| ----------------- | --------------------------------- | ---------------------- |
| `docs-scope`      | 检测 docs-only changes            | Always                 |
| `changed-scope`   | 检测 node/macos/android 变化范围  | Non-docs PRs           |
| `check`           | TypeScript types、lint、format    | Non-docs changes       |
| `check-docs`      | Markdown lint + broken link check | Docs changed           |
| `code-analysis`   | LOC threshold check               | PRs only               |
| `secrets`         | leaked secrets detection          | Always                 |
| `build-artifacts` | 构建 dist 并共享给后续 jobs       | Non-docs, node changes |
| `release-check`   | validate npm pack contents        | After build            |
| `checks`          | Node/Bun tests + protocol check   | Non-docs, node changes |
| `checks-windows`  | Windows-specific tests            | Non-docs, node changes |
| `macos`           | Swift lint/build/test + TS tests  | macOS changes          |
| `android`         | Gradle build + tests              | android changes        |

## Local equivalents

```bash
pnpm check
pnpm test
pnpm check:docs
pnpm release:check
```

## Strict TypeScript baseline

`pnpm check:strict` 仍是 repo-wide truth source。清理期间可用：

```bash
pnpm check:strict:baseline
pnpm check:strict:scoped
```

`check:strict:baseline` 写入 `.artifacts/strict/` 报告。`check:strict:scoped` 仍运行 `pnpm tsgo`，但只在钱包、Marketplace、mining 和最近 touched UI/tool files 的 strict errors 上 fail。
