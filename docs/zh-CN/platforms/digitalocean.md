---
summary: "使用受维护的 Hosting profile 在 DigitalOcean 安装 Fased"
read_when:
  - 你想在 DigitalOcean Droplet 上持续运行 Fased
  - 你需要简单且受支持的 VPS 路径
title: "DigitalOcean"
---

# 在 DigitalOcean 上运行 Fased

使用全新 Ubuntu LTS Droplet 和受维护的非 Docker **Hosting** profile。它会建立独立
`app` 与 signer 账户、root 管理的 signer/updater systemd 服务、Tailscale 私有访问、
SSH/防火墙加固以及协调更新和回滚。

<Warning>
完整 Docker Gateway 只支持本地电脑。DigitalOcean VPS 不存在
`install.sh --hosting-docker`；不要使用旧的 `./install.sh --no-onboard` + 用户级
daemon 步骤，也不要公开端口 `18789`。
</Warning>

## 1. 创建并进入 Droplet

选择全新 Ubuntu LTS 基础镜像、至少 1–2 vCPU / 2 GB RAM、25 GB 磁盘和 SSH key。
保留 DigitalOcean Console 作为恢复路径，然后连接：

```bash
ssh root@YOUR_DROPLET_IP
```

## 2. 执行 Hosting 安装

在 provider root console 中运行 [VPS Hosting 一条命令流程](/install/vps)。安装器
会在特权 Fased 安装前验证 tagged Hosting release。不要先安装 Docker、Node、Go
或全局 Fased，也不要给安装器创建的 `app` 账户添加 sudo。

## 3. 验证私有访问和服务

保持 provider root console 打开，直到自己的电脑已连接同一 tailnet 并通过：

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

作为 Droplet 上的 `app` 用户：

```bash
fased health
fased --version
fased gateway status
fased plugins doctor
fased wallet signer doctor --json
```

使用安装器打印的私有 dashboard 地址；不要创建 DigitalOcean Cloud Firewall 公网
`18789` 规则。正常更新运行 `fased update status`、`fased update` 和 `fased health`。

相关页面：[VPS Hosting](/install/vps)、[Tailscale](/gateway/tailscale)、
[Oracle Cloud](/platforms/oracle)、[Hetzner](/install/hetzner)。
