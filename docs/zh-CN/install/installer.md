---
read_when:
  - 你想了解 `install.sh`
  - 你要在自动化环境中安装
  - 你想确认仓库安装的真实流程
summary: 仓库安装脚本 `install.sh` 的行为、常用参数和自动化方式
title: 安装器内部机制
x-i18n:
  generated_at: "2026-04-21T00:00:00Z"
  model: manual
  provider: codex
  source_path: install/installer.md
---

# 安装器内部机制

本页记录仓库中真实存在的安装器：

- [`install.sh`](https://github.com/fased-ai/fased/blob/main/install.sh)

自己的电脑从零开始时，使用 Local 安装：

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
```

VPS 从零开始时，使用 [执行前验证的 Hosting
bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale)。首次 VPS
推荐 Ubuntu LTS。不要把未经验证的 Hosting 安装器直接 pipe 到特权 shell。

<Warning>
Windows 只支持 WSL2 Ubuntu。需要 Windows 11，或 Windows 10 版本
2004/build 19041 及以上版本。在管理员 PowerShell 中运行
`wsl --install -d Ubuntu`，按提示重启，然后运行 `wsl --update`、
`wsl --version` 和 `wsl --list --verbose`。WSL 必须为 0.67.6 或更新版本，
Ubuntu 必须显示版本 2。打开 Ubuntu 应用，在 Ubuntu shell 中运行 bootstrap
和所有 `fased` 命令。不要在 PowerShell、命令提示符、Git Bash、WSL1 或
原生 Windows Node.js 中运行 Fased。完整步骤见 [Windows
(WSL2)](/platforms/windows)。
</Warning>

## `install.sh` 会做什么

<Steps>
  <Step title="检测主机环境">
    支持 macOS、Linux 和 WSL2。Local 和 Hosting 使用不同的主机安全配置。
  </Step>
  <Step title="确保兼容的工具和 Node.js">
    Fased 推荐 Node 24，并要求 Node 22.14 或更新版本且带内置
    `node:sqlite`。启用自动安装后，安装器可在常见 Linux、WSL2 Ubuntu 和
    已安装 Homebrew 的 macOS 上安装缺失依赖。普通用户不需要安装 Go。
  </Step>
  <Step title="准备 runtime">
    支持的 Linux Local 和 VPS Hosting 通常使用经过 checksum 和 release
    attestation 验证的预构建 runtime。macOS 和明确的 `--source-install`
    使用源码 checkout。checkout 仍是 Local 设置/修复锚点；特权 Hosting
    不会执行 app-owned checkout。
  </Step>
  <Step title="安装稳定 launcher 和 updater">
    CLI launcher 和 updater 位于版本化应用目录之外。候选 runtime 经过
    smoke test 后原子切换；设置、凭证、会话、钱包、Mining 和 signer 数据
    不属于应用 release swap。
  </Step>
  <Step title="按需运行 onboarding">
    未跳过时，安装器运行 `fased onboard --install-daemon`。Local 安装配置
    user service；Hosting 安装 root 管理的 Gateway service，但 Gateway
    仍以非 root `app` 用户运行。
  </Step>
  <Step title="安装 native signer">
    Local 在首次选择 local signer wallet 时自动下载精确版本的 signer asset；
    Hosting 在选择钱包前安装版本匹配、root 管理且使用独立
    `fased-signer` 账户的 signer service。两条路径都验证 SHA-256、release
    manifest 和 GitHub/Sigstore attestation，不会自动回退到 Go 源码构建。
  </Step>
  <Step title="通过 Sync 写入 SAT runtime ids">
    预发布安装保持 `config/sat-runtime.env` 为空。Satcoin mainnet proof
    发布后，在 Mining 页面使用 **Sync** 验证签名 manifest 并写入官方 ids。
  </Step>
</Steps>

## 常见模式

<Tabs>
  <Tab title="Local">
    ```bash
    ./install.sh --local
    ```
  </Tab>
  <Tab title="跳过 onboarding">
    ```bash
    ./install.sh --local --no-onboard
    ```
  </Tab>
  <Tab title="修复 Local / WSL2">
    ```bash
    ./install.sh --repair-local
    ```

    修复 managed Local/WSL runtime 和 user Gateway service，不重新运行
    onboarding，也不重置用户状态。

  </Tab>
  <Tab title="VPS Hosting">
    从 VPS 提供商的 root console 使用 [执行前验证的 Hosting
    bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale)。先验证
    独立 installer asset 和 attestation，再对已下载文件使用 `--hosting` 和
    精确 `--release`。
  </Tab>
  <Tab title="修复 Hosting">
    使用同一个执行前验证流程，只在最后执行已经验证的独立 installer 时改用
    `--repair-hosting`。不要使用 raw `curl | bash`，也不要对
    `/home/app/fased/install.sh` 使用 sudo。
  </Tab>
  <Tab title="详细日志">
    ```bash
    ./install.sh --verbose
    ```
  </Tab>
</Tabs>

<Warning>
不存在 `--hosting-docker`。完整 Docker Gateway 只支持 Local。VPS Hosting
必须使用主机管理、非 Docker 的独立 Gateway/signer/updater 架构。
</Warning>

## 主要公开参数

| 参数                         | 说明                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `--auto-install`             | 在支持的 macOS/Linux 主机上安装缺失依赖                    |
| `--no-auto-install`          | 不自动安装缺失依赖                                         |
| `--install-dir <path>`       | 指定 bootstrap/checkout 目录                               |
| `--local`                    | 使用本地电脑 onboarding 默认值                             |
| `--repair-local`             | 修复 Local/WSL runtime 和 user service，不运行 onboarding  |
| `--hosting`                  | 使用 VPS Hosting 默认值；root bootstrap 还要求 `--release` |
| `--repair-hosting`           | 从已验证的 tagged provider-console bootstrap 修复 Hosting  |
| `--release <vX.Y.Z\|latest>` | 为特权 Hosting 选择并验证精确 release                      |
| `--source-install`           | Local 从源码构建；特权 VPS Hosting 拒绝此选项              |
| `--swap-gb <n>`              | 覆盖小内存 Linux 主机的安装时 swap 大小                    |
| `--no-onboard`               | 安装后跳过 onboarding                                      |
| `--verbose`                  | 显示安装命令输出                                           |
| `--help`                     | 显示当前完整参数                                           |

`--` 后面的额外参数会转发给 `fased onboard --install-daemon`。

## Native signer 安全边界

- Local signer 与 Gateway 使用同一个 OS 账户，但使用独立 Unix socket 和
  fail-closed wallet policy。
- Hosting signer 是 root 安装、`fased-signer` 账户运行的独立 systemd
  service；Gateway 只能访问 `/run/fased-signerd/app.sock`。
- Hosting 的 `app` 用户不能访问 control socket、signer state 或 sudo，也
  不会运行 app-owned Node broker。
- 新建 wallet 在 signer 内部生成 key，只返回 public address；Gateway 和
  dashboard 不接受 private key import。
- 导入已有账户必须使用独立 native signer admin/control-socket 流程。
- 新 wallet 初始为 locked + deny-all。只有 RPC、owner-reviewed policy、精确
  policy hash 和 signer WebAuthn enrollment 都完成后，才能执行 reviewed send。
- Linux/macOS 支持 `amd64` 和 `arm64`；Windows 在 WSL2 中使用 Linux asset。

Local 首次 wallet setup 会先以 read-only 模式 staging 精确 signer
candidate。只有 identity、protocol 和 policy state 验证成功后才切换为
read-write；提交前失败会恢复旧 signer 文件和进程状态。

## 环境变量

- `FASED_INSTALL_REPO=<url>`：Local bootstrap 使用的仓库 URL。
- `FASED_INSTALL_DIR=<path>`：checkout/安装目录。
- `FASED_STATE_DIR=<path>`：config、sessions、credentials、wallets 和 logs
  的 state directory。
- `FASED_CONFIG_PATH=<path>`：显式 config 文件；默认
  `$FASED_STATE_DIR/fased.json`。
- `FASED_CLI_BIN_DIR=<path>`：安装 `fased` launcher 的目录。
- `FASED_INSTALL_VERBOSE=1`：显示安装命令输出。
- `FASED_EXISTING_DATA_ACTION=<mode>`：Local 高级状态选择：`keep`、
  `reset-config` 或 `separate-state`。正常安装默认保留状态。
- `FASED_WALLET_LOCAL_SIGNER_BIN`、`FASED_LOCAL_SIGNER_VERSION`、
  `FASED_LOCAL_SIGNER_BASE_URL`：高级 signer asset override。

运行 `./install.sh --help` 查看当前完整参数和内部兼容选项。

## 自动化

Local 无头安装：

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --local --no-onboard
```

指定 Local 安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --local --install-dir "$HOME/agent" --no-onboard
```

这些 raw bootstrap 只用于 Local。自动化 Hosting 仍必须先下载并验证精确
release 的独立 installer 和 attestation，再执行已经验证的文件。只有在带外
检查确认 `app` 的 Tailscale SSH 路径可用后，自动化才可以确认 SSH/firewall
lock-down。

## npm 和容器

`npm install -g @fased/fased` 是受支持的高级 Local/dev 或自行管理主机路径，
但不会替代 installer 完成 Hosting 的 service、Tailscale、signer 和主机加固。
它不是推荐的 VPS Hosting 安装方式。Bun 全局安装不是公开路径。

Docker 只用于 Local container Gateway/sandbox，详情见
[Docker](/install/docker)。

## 更新

正常用户使用：

```bash
fased update status
fased update
```

不要把 `git pull` 加重新运行通用 installer 当成稳定版本升级流程。stable
解析最新稳定 release tag；`fased update --channel dev` 只适合主动跟踪
`main` 的开发者。事务更新和旧 updater 修复见 [更新](/install/updating)。

## 相关页面

- [安装](/install)
- [更新](/install/updating)
- [Docker](/install/docker)
- [CLI onboarding](/cli/onboard)
