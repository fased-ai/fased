---
read_when:
  - 更新 Fased
  - 更新后出现问题
summary: 通过 `fased update` 安全更新 Local、WSL2、macOS、源码或 VPS Hosting 安装
title: 更新
x-i18n:
  generated_at: "2026-04-21T00:00:00Z"
  model: manual
  provider: codex
  source_path: install/updating.md
---

# 更新

`fased update` 是 Local、WSL2、macOS、源码和 VPS Hosting 的正常版本更新
命令。Control UI 只显示 update status；它不会启动更新。

<Note>
`fased onboard --install-daemon` 用于初始设置和 service 安装，不是版本升级
命令。不要使用 `git pull --rebase` 加重新运行通用 installer 作为普通稳定
更新流程。只有修复/重新安装或旧 updater 无法自我更新时才重新 bootstrap。
</Note>

## 推荐路径

Managed Linux Local 或 WSL2 Ubuntu 可以从任何目录运行：

```bash
fased update status
fased update
```

VPS Hosting 通过 Tailscale 以非 root `app` 用户运行：

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

Hosting onboarding 完成后，`app` shell 应直接进入 `/home/app/fased`。普通
更新不使用 root，也不使用 sudo。root 只用于 provider-console 初次 bootstrap
或受控紧急修复。

常用检查：

```bash
fased update status
fased update --dry-run
fased update
```

Managed artifact 更新需要 restart 和精确 health verification。只有目标没有
runtime 变化时才接受 `--no-restart`；源码和手动 package-manager profile 保留
各自的 restart 选项。

## Stable 和 dev channel

默认是 **stable**：

- git checkout 的 stable 解析最新稳定 `v*` release tag，不跟随移动的
  `main`。
- managed package install 解析精确 npm `latest` 版本，再下载并验证 GitHub
  release layers；不会进行全局 npm dependency reconciliation。
- `fased update --channel dev` 才跟随最新 `main`，只用于明确的开发测试。

| 命令                             | 得到的版本                     |
| -------------------------------- | ------------------------------ |
| `fased update`                   | 当前安装类型的最新稳定 release |
| `fased update --channel dev`     | 最新 `main` checkout           |
| `git pull --ff-only origin main` | 仅贡献者主动更新源码 checkout  |

源码开发者才使用：

```bash
git checkout main
git pull --ff-only origin main
./install.sh --source-install
```

特权 VPS Hosting 拒绝 source checkout。不要在
`/home/app/fased/install.sh` 上使用 sudo，也不要把一次性自行管理开发主机
描述成受维护的 Hosting 安全边界。

## Gateway + signer 配对事务

更新不能让 Gateway 和 native signer 运行不同 release identity。

### Managed Linux Local / WSL2

如果已经配置 native signer，`fased update` 会把 Gateway 和 signer 当成一个
事务：

1. snapshot 当前应用和 signer 状态；
2. staging 与目标 release 精确匹配的 signer，并以 read-only 启动；
3. 激活候选应用；
4. 验证 Gateway version，以及 signer 的 version、commit、build-input digest、
   protocol 和 policy state；
5. 全部健康后才把 signer 提升为 read-write 并提交。

在 durable health 决策前失败会恢复 Gateway 和 signer。决策后如果 signer
数据库可能已经记录请求，则恢复只向前完成，绝不用旧 snapshot 覆盖新请求
状态。

### macOS 和明确的 source install

已经配置 signer 的 tagged macOS/source 更新也使用同一个配对事务。源码
checkout 必须 clean、解析到 production release tag、允许必要 restart，并通过
精确 health check。未 tag 的开发 commit、`--no-restart` 或 install-mode switch
会被拒绝。中断更新会在 Gateway 启动前从 owner-only transaction journal
恢复。

### VPS Hosting

Hosting 使用独立的 root updater，对 root 管理的 Gateway service 和
`fased-signer` service 执行版本匹配、attested、事务化更新。Gateway 以 `app`
运行；`app` 没有 sudo，不能访问 signer control socket 或 signer state。Node
broker 和 app-owned signer lifecycle 不属于 Hosting 路径。

## Signer artifact 验证

Local、WSL2、macOS 和 Hosting 从匹配的 GitHub Release 下载 native signer，
并验证：

- `fased-signerd-checksums.txt`
- GitHub/Sigstore release attestation
- attested `fased-signerd-release.json`
- 运行中 signer health 返回的精确 version、commit 和 build-input digest

验证失败会停止，不会隐式从源码构建。Linux 和 macOS 支持 `amd64` 与
`arm64`；WSL2 使用 Linux asset。普通用户不需要 Go。开发者只有显式设置
`FASED_BUILD_NATIVE_SIGNER_FROM_SOURCE=1` 并提供受支持 Go 版本时才从源码
构建。

## Managed runtime 如何切换

Launcher 和 updater 位于版本化应用目录之外：

```text
~/.fased/bin/fased
~/.fased/bin/fased-service
~/.fased/updater/fased-managed-updater.mjs
~/.fased/runtime/current
~/.fased/runtime/previous
~/.fased/runtime/releases/<version-or-repair-generation>/
~/.fased/install.json
```

Updater 在线解析精确 target，验证 checksums 和 archive paths，staging 并
smoke-test candidate，原子切换 `current`，再验证 Gateway identity、signer 和
plugins。设置、凭证、钱包、signer state、Mining、sessions 和 memory 都位于
state directory，不属于 release swap。

支持的 Linux artifact 使用 application/dependency layers。dependency build
hash 未变化时只替换 application layer；lockfile 或 dependency recipe 变化时
才替换 dependency layer。

## Control UI update status

浏览器中的只读状态位于：

```text
Advanced -> Debug -> Update Status
```

实际更新仍从终端运行：

```bash
fased update status
fased update
```

## 旧 updater 的一次性修复

先尝试 `fased update`。只有旧 CLI 无法启动、更新失败，或报告成功但 version
不变时，才重新 bootstrap。不要删除 `~/.fased` 或 `/home/app/.fased`，也不要
重新 onboarding 来修复 updater。

### Local / WSL2 修复

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --repair-local

hash -r
fased update status
fased update
fased --version
fased doctor
fased gateway restart
fased gateway status
fased plugins doctor
```

它只替换 installer-owned launcher/runtime 和 user service，不覆盖其他用户管理
的同名命令，不重新 onboarding，也不重置持久状态。

### VPS Hosting 修复

从 VPS provider 的 root/recovery console 使用 [手动执行前验证
流程](/install/vps#advanced-verify-the-bootstrap-first)。下载精确 release
的独立 `install.sh` 和 attestation bundle，验证 repository、tag、release
workflow 和 GitHub-hosted runner。只有验证成功后，才在最后执行已验证文件时
使用 `--repair-hosting`。

不要把 raw repository URL pipe 到 root shell，不要从正常 `app` Tailscale
shell 执行修复，也不要对 `/home/app/fased/install.sh` 使用 sudo。

## 更新后验证

```bash
fased --version
fased doctor
fased gateway status
fased plugins doctor
fased dashboard
```

更新只有在以下条件都满足时才完成：CLI、Doctor header 和 Gateway runtime
version 一致；`RPC probe: ok`；signer identity/policy health（如果已配置）与
目标精确匹配；plugin doctor 干净。

## 回滚和模糊广播

Managed updater 会在提交前 health failure 时自动恢复上一个成对的 Gateway +
signer release。任何可能已经成功广播的请求都不会自动重播，也不会通过恢复
旧 signer 数据库来重置 cap/idempotency；系统会先用相同 request id 和
transaction digest reconcile 已知 signature/state。

源码贡献者可以在干净、受控的开发 checkout 中显式选择旧 tag，再运行
`./install.sh --source-install`。这不是普通 Local/Hosting 用户的回滚命令。

## npm 安装

手动 `npm install -g @fased/fased` 是受支持的高级 Local/dev 或自行管理主机
路径。它不是正常 VPS Hosting 路径，也不能建立 Hosting 的 root-managed
service、独立 signer/updater 和 Tailscale 私有访问。

## 相关页面

- [安装](/install)
- [安装器内部机制](/install/installer)
- [CLI 更新命令](/cli/update)
