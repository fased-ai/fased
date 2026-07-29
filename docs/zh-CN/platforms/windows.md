---
read_when:
  - 在 Windows 上安装 Fased
  - 查找 Windows 配套应用状态
summary: Windows（WSL2）支持 + 配套应用状态
title: Windows (WSL2)
x-i18n:
  generated_at: "2026-02-03T07:53:19Z"
  model: manual
  provider: manual
  source_hash: c93d2263b4e5b60cb6fbe9adcb1a0ca95b70cd6feb6e63cfc4459cb18b229da0
  source_path: platforms/windows.md
  workflow: 15
---

# Windows (WSL2)

Windows 上的 Fased 必须在 **WSL2 Ubuntu 内**运行。CLI、Gateway 网关、钱包签名器、更新和服务都在 Linux 内运行。不要使用原生 PowerShell、命令提示符、Git Bash 或原生 Windows Node.js 运行 Fased；钱包签名器需要 Unix socket。

支持 Windows 11，或 Windows 10 版本 2004（build 19041）及以上版本。PowerShell 仅用于安装和管理 WSL2。打开 Ubuntu 后，安装程序和所有 `fased` 命令都必须在 Ubuntu/Linux 提示符中运行。

原生 Windows 配套应用已在计划中。

## 安装 WSL2 Ubuntu 和 Fased

### 1）在管理员 PowerShell 中安装 WSL2

```powershell
wsl --install -d Ubuntu
wsl --update
wsl --version
```

如果系统要求，请重新启动 Windows。`wsl --version` 必须显示 WSL 版本为
`0.67.6` 或更高版本，才能使用 systemd。然后列出已安装的发行版：

```powershell
wsl --list --verbose
```

复制 `NAME` 列中的准确发行版名称；该行必须显示 `VERSION 2`。如果显示
版本 1，请使用准确名称进行转换（名称可能是 `Ubuntu-24.04`，不要猜测）：

```powershell
wsl --set-version "<列表中的准确发行版名称>" 2
```

### 2）打开 Ubuntu

从 Windows 开始菜单打开 **Ubuntu**，并按提示创建 Linux 用户名和密码。确认当前提示符属于 Linux：

```bash
uname -s
pwd
```

`uname -s` 必须输出 `Linux`。正常主目录类似 `/home/YOUR_LINUX_USER`，而不是 `C:\...` 或 `/mnt/c/Windows/System32`。

确认 systemd 正在运行：

```bash
ps -p 1 -o comm=
```

结果必须是 `systemd`。如果不是，请在 Ubuntu 内创建或修改
`/etc/wsl.conf`：

```ini
[boot]
systemd=true
```

关闭 Ubuntu，在 PowerShell 中运行 `wsl --shutdown`，重新打开 Ubuntu，
然后再次检查。Microsoft 官方说明：
[在 WSL 中使用 systemd](https://learn.microsoft.com/windows/wsl/systemd)。

### 3）在 Ubuntu 内安装 Fased

不要在 PowerShell 中运行以下命令。请在 Ubuntu 提示符中运行：

```bash
curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
  | bash -s -- --local
```

以后也请在 Ubuntu 内运行 `fased --version`、`fased doctor`、`fased dashboard`、钱包设置和更新。第一次创建原生钱包时，Fased 会自动下载并校验匹配当前版本的 Linux 签名器；普通用户不需要安装 Go。现有密钥导入必须通过单独的原生签名器管理员命令完成，Gateway 和浏览器不接收私钥。

### 4）在 Windows 浏览器中打开 Dashboard

Gateway 网关继续在 WSL2 内运行，但可以使用普通 Windows 浏览器打开 Dashboard URL。

原生签名器 WebAuthn 注册也必须从 Ubuntu 内启动：

```bash
"$HOME/.fased/bin/fased-signer-enroll" "Primary security key"
```

在 Windows 浏览器中打开它输出的准确
`http://localhost:18791/...` 短期 URL。不要为端口 `18791` 创建
`portproxy`、防火墙入站规则、局域网绑定或公网隧道；注册必须仅限本机回环。

- [入门指南](/start/getting-started)（在 WSL 内使用）
- [安装和更新](/install/updating)
- 官方 WSL2 指南（Microsoft）：https://learn.microsoft.com/windows/wsl/install
- 官方 systemd 指南（Microsoft）：https://learn.microsoft.com/windows/wsl/systemd

## 从 Windows 管理远程 VPS

这与 Local WSL2 安装不同：Fased 在远程 Linux VPS 上运行，Windows 只负责
Tailscale、SSH 和浏览器，不需要在 WSL 中安装 Fased。

1. 安装并登录原生 [Tailscale Windows app](https://tailscale.com/download)。
2. 在 PowerShell 或 Windows Terminal 中连接 VPS：

```powershell
ssh root@YOUR_PUBLIC_VPS_IP
```

3. 提示符变成远程 Linux VPS 后，在该 SSH 会话内按照
   [verified Hosting bootstrap](/install/vps#3-验证并运行-hosting-bootstrap) 操作。

完整说明见 [VPS Hosting](/install/vps)。不要把 Bash Hosting 命令直接粘贴到
未连接 VPS 的 PowerShell 中。

## Gateway 网关

- [Gateway 网关操作手册](/gateway)
- [配置](/gateway/configuration)

## Gateway 网关服务安装（CLI）

在 WSL2 内：

```
fased onboard --install-daemon
```

或：

```
fased gateway install
```

或：

```
fased configure
```

出现提示时选择 **Gateway service**。

修复/迁移：

```
fased doctor
```

## 高级：通过 LAN 暴露 WSL 服务（portproxy）

WSL 有自己的虚拟网络。如果另一台机器需要访问**在 WSL 内**运行的服务（SSH、本地 TTS 服务器或 Gateway 网关），你必须将 Windows 端口转发到当前的 WSL IP。WSL IP 在重启后会改变，因此你可能需要刷新转发规则。

示例（以**管理员身份**运行 PowerShell）：

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

允许端口通过 Windows 防火墙（一次性）：

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

在 WSL 重启后刷新 portproxy：

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

注意事项：

- 从另一台机器 SSH 目标是 **Windows 主机 IP**（示例：`ssh user@windows-host -p 2222`）。
- 远程节点必须指向**可访问的** Gateway 网关 URL（不是 `127.0.0.1`）；使用 `fased status --all` 确认。
- 使用 `listenaddress=0.0.0.0` 进行 LAN 访问；`127.0.0.1` 仅保持本地访问。
- 如果你想自动化，注册一个计划任务在登录时运行刷新步骤。

## Windows 配套应用

我们还没有 Windows 配套应用。如果你想让它实现，欢迎贡献。
