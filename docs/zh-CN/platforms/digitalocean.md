---
read_when:
  - 在 DigitalOcean 上设置 Fased
  - 寻找简单的 VPS 路径来运行 Fased
summary: 在 DigitalOcean 上运行 Fased（简单 VPS 路径）
title: DigitalOcean
x-i18n:
  generated_at: "2026-02-03T07:51:55Z"
  model: manual
  provider: manual
  source_hash: d60559b8751da37413e5364e83c88254b476b2283386a0b07b2ca6b4e16157fc
  source_path: platforms/digitalocean.md
  workflow: 15
---

# 在 DigitalOcean 上运行 Fased

## 目标

在一个小型 DigitalOcean Ubuntu Droplet 上运行持久的 Fased Gateway 网关。

如果你想走 ARM 免费层路径且不介意提供商特定设置，请参阅 [Oracle Cloud 指南](/platforms/oracle)。

## 提供商概览

| 提供商       | 方案            | 配置                  | 价格/月     | 备注                     |
| ------------ | --------------- | --------------------- | ----------- | ------------------------ |
| Oracle Cloud | Always Free ARM | 最高 4 OCPU、24GB RAM | $0          | ARM，容量有限 / 注册有坑 |
| Hetzner      | CX22            | 2 vCPU、4GB RAM       | €3.79 (~$4) | 低成本 VPS               |
| DigitalOcean | Basic           | 1 vCPU、1GB RAM       | $6          | 界面简单，文档完善       |
| Vultr        | Cloud Compute   | 1 vCPU、1GB RAM       | $6          | 多地区可选               |
| Linode       | Nanode          | 1 vCPU、1GB RAM       | $5          | 现为 Akamai 旗下         |

**选择提供商：**

- DigitalOcean：最简单的用户体验 + 可预测的设置（本指南）
- Hetzner：性价比高（参见 [Hetzner 指南](/install/hetzner)）
- Oracle Cloud：可以 $0/月，但更麻烦且仅限 ARM（参见 [Oracle 指南](/platforms/oracle)）

---

## 前提条件

- DigitalOcean 账户
- SSH 密钥对（或愿意使用密码认证）
- 约 20 分钟

## 1) 创建 Droplet

1. 登录 [DigitalOcean](https://cloud.digitalocean.com/)
2. 点击 **Create → Droplets**
3. 选择：
   - **Region：** 离你（或你的用户）最近的地区
   - **Image：** Ubuntu 24.04 LTS
   - **Size：** Basic → Regular → **$6/mo**（1 vCPU、1GB RAM、25GB SSD）
   - **Authentication：** SSH 密钥（推荐）或密码
4. 点击 **Create Droplet**
5. 记下 IP 地址

## 2) 通过 SSH 连接

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) 安装 Fased

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -e 'require("node:sqlite"); console.log("node:sqlite ok")'

# Install Fased
git clone https://github.com/fased-ai/agent.git fased
cd fased
./install.sh --no-onboard

# Verify
fased --version
```

## 4) 先加入 Tailscale

托管部署建议在新手引导前先把主机加入 tailnet，这样之后访问仍保持私有。

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=fased-do
```

## 5) 运行新手引导

```bash
fased onboard --install-daemon
```

使用 **hosting** profile。向导将引导你完成：

- 主机 profile、workspace、Gateway 绑定/认证和托管安全
- Gateway 网关令牌生成
- 如果你选择相关路径，可选配置钱包/挖矿
- 守护进程安装（systemd）

Gateway 在线后，在 Control UI 中从所选 Agent 完成产品设置：**Agent > Models**、
**Agent > Channels**、**Agent > Services**、**Agent > Skills**、**Agent > Memory** 和
**Agent > Tasks**。

## 6) 验证 Gateway 网关

```bash
# Check status
fased status

# Check service
systemctl --user status fased-gateway.service

# View logs
journalctl --user -u fased-gateway.service -f
```

## 7) 访问 Control UI

Gateway 网关默认绑定到 loopback。要访问控制界面：

**选项 A：SSH 隧道（推荐）**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**选项 B：Tailscale Serve（HTTPS，仅 loopback）**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
fased config set gateway.tailscale.mode serve
fased gateway restart
```

打开：`https://<magicdns>/`

注意事项：

- Serve 保持 Gateway 网关仅 loopback 并通过 Tailscale 身份头进行认证。
- 要改为需要令牌/密码，请设置 `gateway.auth.allowTailscale: false` 或使用 `gateway.auth.mode: "password"`。

**选项 C：Tailnet 绑定（不使用 Serve）**

```bash
fased config set gateway.bind tailnet
fased gateway restart
```

打开：`http://<tailscale-ip>:18789`（需要令牌）。

打开后，使用 **Dashboard** 查看概览，使用 **Chat** 测试 Agent，使用
**Agents** 管理模型、频道、Skills、Tools、Memory、Services 和 Tasks，使用
**Advanced** 管理 Config、Debug 和 Nodes。

## 8) 连接你的渠道

普通频道设置和路由使用 **Agent > Channels**。下面的 CLI 示例适合脚本修复或纯 SSH 工作流。

### Telegram

```bash
fased pairing list telegram
fased pairing approve telegram <CODE>
```

### WhatsApp

```bash
fased channels login whatsapp
# Scan QR code
```

参见[渠道](/channels)了解具体频道设置，然后在 **Agent > Channels** 管理所选 Agent 的账号路由。

---

## 1GB RAM 的优化

$6 的 droplet 只有 1GB RAM。为了保持运行流畅：

### 添加 swap（推荐）

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 使用更轻量的模型

如果遇到 OOM，考虑：

- 使用基于 API 的模型（Claude、GPT）而不是本地模型
- 将 `agents.defaults.model.primary` 设置为更小的模型

### 监控内存

```bash
free -h
htop
```

---

## 持久化

所有状态存储在：

- `~/.fased/` — 配置、凭证、会话数据
- `~/.fased/workspace/` — 工作区（SOUL.md、记忆等）

这些在重启后保留。定期备份：

```bash
tar -czvf fased-backup.tar.gz ~/.fased ~/.fased/workspace
```

---

## Oracle Cloud 替代路径

Oracle Cloud 有 ARM 免费层路径。如果容量可用且你能接受 OCI 特定设置，它可以用于运行 Fased。

| 你将获得       | 配置                     |
| -------------- | ------------------------ |
| **4 OCPUs**    | ARM Ampere A1            |
| **24GB RAM**   | 绰绰有余                 |
| **200GB 存储** | 块存储卷                 |
| **费用**       | 免费层，受提供商条款影响 |

**注意事项：**

- 注册可能有点麻烦（失败了就重试）
- ARM 架构 — 大多数东西都能工作，但有些二进制文件需要 ARM 构建

完整设置指南请参阅 [Oracle Cloud](/platforms/oracle)。关于注册技巧和注册流程故障排除，请参阅此[社区指南](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)。

---

## 故障排除

### Gateway 网关无法启动

```bash
fased gateway status
fased doctor --non-interactive
journalctl -u fased --no-pager -n 50
```

### 端口已被使用

```bash
lsof -i :18789
kill <PID>
```

### 内存不足

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## 另请参阅

- [Hetzner 指南](/install/hetzner) — 更便宜、更强大
- [Docker 安装](/install/docker) — 容器化设置
- [Tailscale](/gateway/tailscale) — 安全远程访问
- [配置](/gateway/configuration) — 完整配置参考
