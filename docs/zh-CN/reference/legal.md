---
summary: "License、third-party notices、risk disclosure 和 release boundaries。"
read_when:
  - 你在准备发布
  - 你需要 legal 和 risk 文档地图
title: "Legal and Risk"
---

# Legal and Risk

本页是 Fased legal、notice 和 risk-disclosure surface 的简短地图。

## Core files

- [`LICENSE`](https://github.com/fased-ai/fased/blob/main/LICENSE)
- [`SECURITY.md`](https://github.com/fased-ai/fased/blob/main/SECURITY.md)
- [`THIRD_PARTY_NOTICES.md`](https://github.com/fased-ai/fased/blob/main/THIRD_PARTY_NOTICES.md)
- [`docs/legal/disclaimer.md`](https://github.com/fased-ai/fased/blob/main/docs/legal/disclaimer.md)
- [`CONTRIBUTING.md`](https://github.com/fased-ai/fased/blob/main/CONTRIBUTING.md)
- [`docs/reference/plugin-license-policy.md`](https://github.com/fased-ai/fased/blob/main/docs/reference/plugin-license-policy.md)

## 文件用途

### `LICENSE`

核心代码库 license。该 repo 在需要时保留 MIT-licensed code 的 attribution，同时对 Fased work 有单独 modification notice。

### `THIRD_PARTY_NOTICES.md`

发布或再分发时必须保留的 third-party code、fonts、data 和 notice files 地图。

### `SECURITY.md`

公开安全报告政策，以及当前 self-hosted runtime model 的 trust-boundary summary。

### `docs/legal/disclaimer.md`

产品风险说明，覆盖 wallets、crypto、mining、Fased Network、operator roles、reviewed wallet actions、news/market-intelligence features。这里放 “not financial advice”，不要放进 repository license。

### `CONTRIBUTING.md`

贡献规则、maintainer expectations、attribution expectations，以及改变用户/operator 行为的 PR 必须更新什么。

### `docs/reference/plugin-license-policy.md`

Standalone plugins 可以使用自己 license 的规则，以及 plugin 复制或 vendored third-party code 时的处理方式。

## Release rule of thumb

对任何涉及 real funds、real routing 或 unattended operation 的 ready claim，都要清楚区分：

- read-only preview
- gated but implemented
- live and approved

Fased 包含 wallet、mining、Fased Network 和 operator trust surfaces，这个区分比普通聊天工具更重要。
