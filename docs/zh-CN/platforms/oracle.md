---
summary: "使用受维护的 Hosting profile 在 Oracle Cloud ARM VPS 安装 Fased"
read_when:
  - 你想在 Oracle Cloud 运行常驻 Fased
  - 你需要 ARM64 VPS 的受支持安装路径
title: "Oracle Cloud"
---

# 在 Oracle Cloud（OCI）上运行 Fased

Oracle Ampere ARM64 VM 可以运行受维护的 Fased Hosting profile。不要在 app-owned
checkout 中用 sudo 安装，也不要使用旧的 `./install.sh --no-onboard` + 用户级 daemon
步骤。完整 Docker Gateway 只支持本地电脑，不是 OCI VPS 安装路径。

## 1. 创建实例

在 Oracle Cloud 创建 Ubuntu 24.04 ARM64 实例，建议至少 2 vCPU、4 GB RAM 和 25 GB
磁盘；添加 SSH 公钥并保留 OCI Console/Rescue 访问。不要开放 Gateway 端口 `18789`。

## 2. 进入 provider root shell

```bash
ssh ubuntu@YOUR_PUBLIC_IP
sudo -i
```

后续安装命令都在这个 root shell 中运行。不要先手动安装 Node、Go、Docker 或全局 Fased。

## 3. 执行受验证的 Hosting 安装

按照 [VPS 的预执行验证稳定版流程](/install/vps#3-安装-fased-并通过-tailscale-连接)
下载独立 `install.sh` 和 attestation bundle，使用 `gh attestation verify` 约束仓库、
精确 tag、workflow 和 GitHub-hosted runner，然后才执行：

```bash
bash "$BOOTSTRAP_DIR/install.sh" --hosting --release "$RELEASE"
```

安装器会建立独立 `app` 与 signer 账户、root 更新器/systemd 服务、Tailscale 私有访问、
SSH/防火墙加固和事务回滚。不要给 `app` 添加 sudo。

## 4. 验证

保持 OCI provider 会话打开，直到从同一 tailnet 的电脑确认：

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

然后作为 `app` 用户运行：

```bash
fased health
fased --version
fased gateway status
fased plugins doctor
fased wallet signer doctor --json
```

正常更新使用 `fased update status`、`fased update`、`fased health`。OCI VCN 只保留安装
和 Tailscale 所需的网络访问；不要把 dashboard/Gateway 直接公开到公网。

相关页面：[VPS Hosting](/install/vps)、[Tailscale](/gateway/tailscale)、
[DigitalOcean](/platforms/digitalocean)、[Hetzner](/install/hetzner)。
