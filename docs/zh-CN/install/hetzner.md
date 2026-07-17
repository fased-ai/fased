---
summary: "使用受维护的 Hosting profile 在 Hetzner VPS 安装 Fased"
read_when:
  - 你想让 Fased 在 Hetzner VPS 上持续运行
  - 你需要受支持的非 Docker Hosting 与 Tailscale 流程
title: "Hetzner"
---

# 在 Hetzner 上运行 Fased

在普通 Ubuntu LTS VPS 上使用受维护的 **Hosting** 安装器。它会创建非 root `app`
账户、安装独立原生签名器和 root 更新器、配置 systemd、接入 Tailscale、加固远程
访问，并协调更新与回滚。

<Warning>
不要在 Hetzner VPS 上运行完整 Docker Gateway。Docker Gateway 只支持本地电脑，
不存在 `install.sh --hosting-docker`。请使用 `install.sh --hosting`。
</Warning>

1. 创建 Ubuntu LTS 服务器，添加 SSH 公钥，并保留 Hetzner Console/Rescue 作为恢复路径。
2. 不要在防火墙中开放 Gateway 端口 `18789`。
3. 通过初始公网 SSH 进入 provider root console：

   ```bash
   ssh root@YOUR_PUBLIC_VPS_IP
   ```

4. 在该 root 会话中执行 [VPS 的预执行验证稳定版安装流程](/install/vps#3-安装-fased-并通过-tailscale-连接)。
   不要先自行安装 Docker、Node、Go 或全局 Fased。
5. Tailscale 显示登录 URL 时，在自己的电脑上完成授权；在私有连接验证成功前不要关闭
   初始 provider 会话。
6. 从已连接同一 tailnet 的电脑验证：

   ```bash
   tailscale ping YOUR_VPS_TAILSCALE_NAME
   tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
   ```

7. 作为 VPS 上的 `app` 用户验证：

   ```bash
   fased health
   fased --version
   fased gateway status
   fased plugins doctor
   fased wallet signer doctor --json
   ```

正常更新时，通过 Tailscale 连接为 `app` 后运行 `fased update status`、`fased update`
和 `fased health`。Docker 可以只用于可选 Agent 沙箱；Gateway 和签名器仍必须由
Hosting 安装器在主机上管理。
