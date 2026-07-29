---
summary: "Advanced 安装器验证、flag、限制、修复与恢复。"
read_when:
  - 你需要 exact-tag 预执行验证
  - 你要修复或自动化安装
title: "Advanced Installer Reference"
sidebarTitle: "Advanced Installer"
---

# Advanced Installer Reference

本页用于 exact release 选择、repair、automation 与失败恢复。正常用户应从
[安装](/install) 或 [VPS Hosting](/install/vps) 开始。

## Exact-tag 预执行验证

下面的流程会在 Bash 执行前验证 tagged `install.sh`。从操作系统签名软件源
安装 GitHub CLI，选择 stable release，并替换 `vX.Y.Z`：

```bash
(
set -euo pipefail
RELEASE=vX.Y.Z
BOOTSTRAP_DIR="$(mktemp -d)"
trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT
chmod 0700 "$BOOTSTRAP_DIR"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh"
curl -fsSLo "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/install.sh.attestation.json"
GH_PROMPT_DISABLED=1 gh attestation verify "$BOOTSTRAP_DIR/install.sh" \
  --repo fased-ai/fased \
  --bundle "$BOOTSTRAP_DIR/install.sh.attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners
chmod 0500 "$BOOTSTRAP_DIR/install.sh"
bash "$BOOTSTRAP_DIR/install.sh" --hosting --release "$RELEASE"
)
```

Local 安装只替换最后一行：

```bash
bash "$BOOTSTRAP_DIR/install.sh" --local --release "$RELEASE"
```

任何下载或验证失败都必须停止。

## Hosting 修复与恢复

streamed Hosting 只用于全新安装。已有 host 的 repair 必须复用上面的 exact-tag
流程，并只替换最后一行：

```bash
bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
```

只有已安装 updater 或 root-managed service 无法正常恢复时才使用 repair。
不要从 branch pipe `--repair-hosting`，不要传入调用方创建的 verified marker，
也不要给 operator broad sudo。

## Public mode

| Mode                 | 用途                                          | 可信入口约束                     |
| -------------------- | --------------------------------------------- | -------------------------------- |
| `--local`            | macOS、Linux 或 WSL2 Ubuntu 的全新 Local 安装 | 仅 immutable release asset       |
| `--hosting`          | 支持的 systemd VPS 全新 Hosting 安装          | 仅 immutable release asset       |
| `--repair-local`     | 保留状态并修复 Local runtime/service          | 正常不需要 root                  |
| `--repair-hosting`   | 保留状态并修复 Hosting runtime/service        | 不可以；仅 exact tagged file     |
| `--release <vX.Y.Z>` | 选择 immutable stable release                 | exact release asset 与 channel   |
| `--source-install`   | Local developer source build                  | privileged Hosting 拒绝          |
| `--no-onboard`       | 安装 runtime 但跳过 onboarding                | 仅允许的 Local 或 exact-tag 流程 |

从可信 checkout 运行 `./install.sh --help` 查看当前完整参数。

## Streamed Hosting 限制

immutable release-asset Hosting 命令接受 `--hosting`，或
`--hosting --release vX.Y.Z[-prerelease] --update-channel stable|beta`。
未写入 release identity 的 streamed branch 脚本会在安装前退出。验证 tagged
payload 前会拒绝：

- repair、source、无效 channel/release 和 host-profile selector；
- 调用方提供的 `--verified-hosting-bundle`；
- exported `FASED_*`；
- proxy、自定义 CA、GitHub CLI config、dynamic loader、shell startup 与 temp
  directory override；以及
- 已存在 Fased state、service、helper 或 installer root 的 host。

持久化修改前，bootstrap 验证 offline-attested release manifest、workflow、tag、
commit、architecture、app/dependency/signer digest、archive path、link、owner、
可写 mode、package version 与 build identity。

## Runtime 与账号边界

| Identity        | 用途                                          | Signer 权限                              |
| --------------- | --------------------------------------------- | ---------------------------------------- |
| `root`          | 首次 bootstrap 与 exact-tag emergency repair  | 安装隔离 service；不是正常 wallet UX     |
| `app`           | Human operator SSH 与 native wallet lifecycle | 受限 `operator.sock`                     |
| `fased-gateway` | Gateway service                               | 只能使用 application `app.sock`          |
| `fased-signer`  | Native signer service                         | 拥有 key、policy、network state 与 audit |

Local 与 Hosting 使用相同 `fased wallet` 命令。Hosting 通过受限 operator socket
执行 create、import、recovery、raw export、RPC 修改与 Mining retirement，不需要
未文档化 root helper。

## Wallet setup contract

- Operator 明确选择永久 `agent`、`mining` 或 `vault` role。
- Create/import/recovery 以可恢复 lifecycle 安装 signer-owned role baseline v1
  与一个已验证 primary RPC。
- 新 Agent/Vault 可立即执行 owner-reviewed action；automation 仍需明确 cap、
  destination、program 与 grant。
- 新 Mining 只有在 release-bound SAT manifest 验证后才 SAT-ready，且仍需资金。
- Legacy deny-all wallet 不会自动扩权；review role 后明确运行
  `fased wallet policy activate-role-baseline ... --confirm`。
- 创建 Agent wallet 不会自动把它设为 Default Agent wallet。

详见 [Wallet CLI](/cli/wallet)、
[role 与 policy](/plugins/crypto/wallet-roles-and-policies) 和
[wallet selection](/plugins/crypto/wallet-selection-contract)。

## 失败与恢复行为

prerequisite、attestation、digest、archive、identity、service health 或 updater
check 失败时，安装器停止。Hosting 使用 staging 与 lock；失败清理 temporary
extract，并明确告诉你应重新运行 fresh 命令还是 exact-tag repair。

正常更新是 transactional：updater stage immutable release，检查 runtime identity
与 health；新 Gateway 不健康时回滚 activation。
