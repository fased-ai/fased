---
summary: "通过 Tailscale 私有访问，在常驻 VPS 上安装 Fased。"
read_when:
  - 你想在云端运行 Fased
  - 你需要 VPS Hosting 安装或恢复说明
title: "VPS Hosting"
---

# VPS Hosting

VPS Hosting 适合需要常驻在线的 Fased。首次安装推荐 Ubuntu LTS。受维护的
流程是主机管理的 `install.sh --hosting`；完整 Docker Gateway 只支持 Local。

## 三步安装

### 1. 准备自己的电脑

安装并登录 [Tailscale](https://tailscale.com/download)，保持在线。这台电脑
用于打开 dashboard 和测试私有 SSH。

### 2. 进入 VPS

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

下面的命令只在这个远程 VPS SSH 会话中运行。

### 3. 验证并运行 Hosting bootstrap

先在 VPS 安装支持 `gh attestation verify` 的当前版
[GitHub CLI](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)，然后运行：

```bash
(
set -euo pipefail
RELEASE=v0.1.65
BOOTSTRAP_DIR="$(mktemp -d)"
trap 'rm -rf "$BOOTSTRAP_DIR"' EXIT
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

安装器会自动：

- 安装 `RELEASE` 指定的精确 stable tag；
- 在安装特权 Fased 资产前验证 tagged release manifest、对应架构 bundle 和
  GitHub attestation；
- 通过签名 package repository 在 VPS 安装/启动 Tailscale；
- 创建非 root `app` runtime 和 root-managed service；
- 引导 Tailscale SSH、防火墙和私有 dashboard 检查。

它显示 Tailscale 登录 URL 时，在自己的电脑浏览器中打开。无需先在 VPS 手动
安装 Tailscale。

<Warning>
不要在本地电脑或未连接 VPS 的 PowerShell 中运行 Hosting 命令。保留 provider
console，直到 Tailscale SSH 和 dashboard 都正常。
</Warning>

## 验证私有访问

从自己的电脑测试：

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
```

只有成功进入 `/home/app/fased` 后才确认安装器的锁定步骤。安装完成后使用：

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased health
fased dashboard
```

## 高级验证与精确 release 选择

<Accordion title="在运行 install.sh 前手动验证 attestation">
  上面的普通流程已经在执行前验证 bootstrap。高级用户可以把 `RELEASE` 改为
  另一个精确 stable tag、在最后的 `bash` 前检查脚本，或保存 attestation JSON
  作为安装记录。不要使用 `main`、`latest` 或其他移动引用。

紧急修复使用同一个 verified block，只把最后一行改为
`--repair-hosting --release "$RELEASE"`。修复流程不接受 streamed shell 输入。
</Accordion>

## 更新和恢复

正常更新以 `app` 通过 Tailscale 运行：

```bash
fased update status
fased update
```

不要对 `/home/app/fased/install.sh` 使用 sudo。只有 root-managed updater 或
service 损坏时，才从 provider root console 使用上面的 exact-tag 手动验证流程，
并把最后一行改为：

```bash
bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
```

不要把 `--repair-hosting` 从 moving `main` pipe 到 root shell。

<Accordion title="Tailscale 或 VPN 故障排查">
  在自己的电脑确认 Tailscale 在线，并在设置期间关闭其他 VPN：

```bash
tailscale status
tailscale ping YOUR_VPS_TAILSCALE_NAME
ssh app@YOUR_VPS_TAILSCALE_NAME
ssh app@100.x.x.x
```

`no matching peer` 通常表示电脑和 VPS 不在同一 tailnet；只有 hostname 失败
通常表示其他 VPN 或 DNS 覆盖 MagicDNS。
</Accordion>

## 建议规格

- 1 vCPU / 1 GB RAM：测试下限，安装可能很慢。
- 2 GB RAM：小型常驻 Agent 的实用最低配置。
- 2 vCPU / 4 GB RAM：多个 tools/services 更舒适。
- 磁盘至少 25 GB。

Hosting hardening 维护 Ubuntu、Fedora 和 RHEL-family systemd Linux。提供商
页面使用同一个 `install.sh --hosting` 流程。
