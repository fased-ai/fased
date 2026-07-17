---
summary: "使用受维护的 Hosting profile 在 GCP Compute Engine 安装 Fased"
read_when:
  - 你想让 Fased 在 Compute Engine VM 上持续运行
  - 你需要受支持的非 Docker Hosting 与 Tailscale 流程
title: "GCP"
---

# 在 GCP Compute Engine 上运行 Fased

创建普通 Ubuntu LTS VM，并使用受维护的 **Hosting** 安装器。它会创建非 root `app`
账户、安装独立原生签名器和 root 更新器、配置 systemd、接入 Tailscale、加固远程
访问，并协调更新与回滚。

<Warning>
不要在 GCP VM 上运行完整 Docker Gateway。Docker Gateway 只支持本地电脑，不存在
`install.sh --hosting-docker`。请使用 `install.sh --hosting`，并且不要为 `18789`
创建公网防火墙规则或外部负载均衡器。
</Warning>

1. 在 Compute Engine 中创建符合 [VPS 规格建议](/install/vps#建议的-vps-规格) 的
   Ubuntu LTS VM，并保留 Cloud Console 作为恢复路径。
2. 进入 VM 的 root shell：

   ```bash
   gcloud compute ssh fased-gateway --zone=YOUR_ZONE
   sudo -i
   ```

3. 在该 root shell 中执行 [VPS 的预执行验证稳定版安装流程](/install/vps#3-安装-fased-并通过-tailscale-连接)。
   不要先自行安装 Docker、Node、Go 或全局 Fased。
4. 在自己的电脑上授权 Tailscale，并在关闭初始 Cloud Console/SSH 会话前验证：

   ```bash
   tailscale ping YOUR_VPS_TAILSCALE_NAME
   tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
   ```

5. 作为 VM 上的 `app` 用户验证：

   ```bash
   fased health
   fased --version
   fased gateway status
   fased plugins doctor
   fased wallet signer doctor --json
   ```

正常更新时运行 `fased update status`、`fased update` 和 `fased health`。Docker 可以
只用于可选 Agent 沙箱；Gateway 和签名器仍必须由 Hosting 安装器在主机上管理。
