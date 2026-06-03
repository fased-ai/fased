---
read_when:
  - 调试仅限 Node 的开发脚本或 watch 模式失败
  - 排查 Fased 中 tsx/esbuild 加载器崩溃问题
summary: Node + tsx "__name is not a function" 崩溃说明及解决方法。
title: Node + tsx 崩溃
x-i18n:
  generated_at: "2026-02-01T20:24:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f9e9bd2281508337a0696126b0db2d47a2d0f56de7a11872fbc0ac4689f9ad41
  source_path: debug/node-issue.md
  workflow: 14
---

# Node + tsx "\_\_name is not a function" 崩溃

## 概述

通过 Node 使用 `tsx` 运行 Fased 时，启动阶段报错：

```
[fased] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

此问题出现在直接使用 `node --import tsx ...` 的开发路径中。相同代码在先构建、再运行编译入口时可以正常工作。

## 环境

- Node: v25.x（在 v25.3.0 上观察到）
- tsx: 4.21.0
- 操作系统: macOS（其他运行 Node 25 的平台也可能复现）

## 复现步骤（仅 Node）

```bash
# 在仓库根目录
node --version
pnpm install
node --import tsx src/entry.ts status
```

## 仓库内最小复现

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node 版本检查

- Node 25.3.0：失败
- Node 22.22.0（Homebrew `node@22`）：失败
- Node 24：需要在出现崩溃的本机环境中验证

## 说明 / 假设

- `tsx` 使用 esbuild 转换 TS/ESM。esbuild 的 `keepNames` 会生成一个 `__name` 辅助函数，并用 `__name(...)` 包裹函数定义。
- 崩溃表明 `__name` 存在但在运行时不是函数，这意味着在 Node 25 的加载器路径中该辅助函数缺失或被覆盖。
- 其他 esbuild 使用者也报告过类似的 `__name` 辅助函数缺失或被重写的问题。

## 解决方法

- 使用常规 runner 脚本，而不是直接运行 `node --import tsx`：
  ```bash
  pnpm fased status
  pnpm gateway:watch
  ```
- 或先构建，再运行编译产物：
  ```bash
  pnpm build:fast
  node --watch fased.mjs status
  ```
- 已在本地确认：编译产物加 `node fased.mjs status` 在 Node 25 上可正常运行。
- 如果可能，在 TS 加载器中禁用 esbuild 的 keepNames（防止插入 `__name` 辅助函数）；tsx 目前不提供此配置项。
- 在受支持的 Node LTS 和本机最新 Node 上测试 `tsx`，确认问题是否与特定 Node/loader 组合有关。

## 参考资料

- https://opennext.js.org/cloudflare/howtos/keep_names
- https://esbuild.github.io/api/#keep-names
- https://github.com/evanw/esbuild/issues/1031

## 后续步骤

- 在受支持的 Node LTS 和本机最新 Node 上复现。
- 测试 `tsx` nightly 版本，或在存在已知回归时固定到早期版本。
- 如果在 Node LTS 上也能复现，则向上游提交包含 `__name` 堆栈跟踪的最小复现。
