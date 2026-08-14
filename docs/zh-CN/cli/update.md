---
read_when:
  - 你想安全更新 managed Local 或 Hosting 安装
  - 你需要了解 `--update` 简写
summary: 使用受验证的 Go lifecycle 更新 managed Fased 安装
title: update
---

# `fased update`

受支持的 managed Linux Local、WSL2 和 VPS Hosting 安装只使用：

```bash
fased update status
fased update
```

稳定 launcher 位于可替换 application generation 之外。它通过签名的 GitHub
Release index 解析目标，验证 architecture-specific artifact，并由 Go
lifecycle host 执行切换、服务重启、health、state preservation 和 rollback。
Managed 更新不会查询 npm registry，也不会运行全局 package-manager update。

如果已经是目标版本并且 runtime identity 与 health 正确，命令返回
`Already current: <version>`，不下载、不切换、不重启。

## 常用命令

```bash
fased update
fased update status
fased update wizard
fased update --channel beta
fased update --dry-run
fased update --json
fased --update
```

- `stable`：默认 end-user channel，由签名 release index 解析。
- `beta`：显式 prerelease channel。
- `dev`：仅用于 source/developer checkout，可跟随 `origin/main`。
- `--no-restart`：不适用于 managed runtime activation；managed transaction
  只有在正确服务重启并报告目标 identity 后才成功。

VPS Hosting 正常更新应通过 Tailscale 以 `app` 用户执行。Root 只用于首次
bootstrap 或明确 repair：

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

旧的全局 npm/pnpm 安装仅作为 migration input。请运行受验证的 public
installer 进入 maintained managed layout；不要把 npm、pnpm、Node、Git 或
GitHub CLI 当作 managed lifecycle authority。

Source checkout 没有 signer state 时仍可使用 developer update flow。带有
signer state 的 checkout 会 fail closed，并要求通过 verified installer
迁移或 repair。

详细 contract、repair 路径和平台说明请参阅[更新](/install/updating)。

## `--update` 简写

```bash
fased --update
```

等同于：

```bash
fased update
```
