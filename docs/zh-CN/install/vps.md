---
summary: "Fased 受维护的非 Docker VPS Hosting 流程"
read_when:
  - 你想在云端运行 Gateway
  - 你需要 VPS/Hosting 安装入口
title: "VPS Hosting"
---

# VPS Hosting

受支持的 VPS 路径是主机管理的 `install.sh --hosting` profile。完整 Docker Gateway
只支持本地电脑；不存在 `--hosting-docker`。Fly.io/Render 容器 manifest 是归档，
不受支持。

Hosting 在普通 systemd Linux VPS 上创建独立 `app` 与 signer 账户、root 管理的原生
签名器和更新器，并使用 Tailscale 提供私有 dashboard/SSH。Ubuntu LTS 是首次安装的
推荐系统；不要公开 Gateway 端口 `18789`。

## 建议的 VPS 规格

- 1 vCPU / 1 GB RAM 只是测试下限；需要 swap，安装和 onboarding 可能很慢。
- 1–2 vCPU / 2 GB RAM 是建议最低配置。
- 2 vCPU / 4 GB RAM 更适合常驻 Gateway、channel 和任务。
- 使用至少 25 GB 磁盘，并备份 Fased 状态和 Agent workspace。

## 1. 在自己的电脑上准备 Tailscale

安装 Tailscale、登录将用于 VPS 的同一 tailnet，并暂时关闭其他 VPN。保留 VPS
provider 的 Console/Rescue 访问，用于 Tailscale 账户丢失或主机恢复。

## 2. 进入 VPS

先使用 provider 提供的初始方式 SSH 到全新 VPS，通常是：

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

下面的命令在这个 **VPS root 会话**内运行；不要直接粘贴到本地 PowerShell。

## 3. 安装 Fased 并通过 Tailscale 连接

为了在任何 Fased shell 代码以 root 运行前验证它，请先从 VPS 发行版的可信包源安装
GitHub CLI 并确认 `gh version`，然后下载和验证精确稳定版的独立安装器：

```bash
RELEASE=vX.Y.Z # 替换为要安装的稳定版本
BOOTSTRAP_DIR="$(mktemp -d)"
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
rm -rf "$BOOTSTRAP_DIR"
```

验证会约束文件 digest、`fased-ai/fased` 仓库、精确 tag、精确发布 workflow 和
GitHub-hosted runner provenance。任何下载或 attestation 验证失败都必须停止；不要退回
到未经验证的 `curl | bash` Hosting 命令。

安装器显示 Tailscale 登录 URL 时，在自己的电脑浏览器中完成授权。保持 provider root
会话打开，直到从同一 tailnet 验证：

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

## 4. 验证和更新

作为 VPS 上的 `app` 用户：

```bash
fased health
fased --version
fased gateway status
fased plugins doctor
fased wallet signer doctor --json
```

正常更新：

```bash
fased update status
fased update
fased health
```

Hosting Gateway 和 signer 由 systemd 独立管理，Gateway 账户没有 sudo。冷启动不会让
Gateway 提权或启动 signer。Docker 可以额外安装并只用于 Agent 沙箱，但不能托管完整
Gateway。提供商指南：[Hetzner](/install/hetzner)、[GCP](/install/gcp)、
[Oracle Cloud](/platforms/oracle)、[DigitalOcean](/platforms/digitalocean)。
