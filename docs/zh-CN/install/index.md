---
read_when:
  - 安装 Fased
  - 选择 Local 或 VPS Hosting
summary: 在本地电脑或常驻 VPS 上安装 Fased。
title: 安装
x-i18n:
  generated_at: "2026-07-18T00:00:00Z"
  model: manual
  provider: codex
  source_path: install/index.md
---

# 安装

**Local** 在自己的电脑上运行。**VPS Hosting** 在远程 Linux 服务器上常驻。

<Tabs>
  <Tab title="Local">
    在 macOS Terminal、Linux terminal 或 Ubuntu WSL2 shell 中运行：

    ```bash
    curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --local
    ```

    Windows 必须在 WSL2 Ubuntu 内运行 Fased；不要在 PowerShell、命令提示符、
    Git Bash 或原生 Windows Node.js 中运行。参见
    [Windows (WSL2)](/platforms/windows)。Local 不会应用 VPS 的 SSH/防火墙加固，
    Tailscale 可选。

  </Tab>

  <Tab title="VPS Hosting">
    首次部署推荐全新的 Ubuntu LTS VPS：

    1. 在自己的电脑安装并登录 [Tailscale](https://tailscale.com/download)。
    2. 使用 provider 提供的账户进入 VPS：

       ```bash
       ssh root@YOUR_PUBLIC_VPS_IP
       ```

    3. 在该 VPS SSH 会话内按照
       [verified Hosting bootstrap](/install/vps#3-验证并运行-hosting-bootstrap) 操作。

    此流程在执行前验证精确 tagged bootstrap。安装器随后在安装特权 Fased 资产前验证 tagged Hosting
    release 和 attestation，并在 VPS 上安装/启动 Tailscale、创建非 root `app`
    runtime。它显示 Tailscale 登录 URL 时，在自己的电脑浏览器中打开。

    完整步骤、访问检查和高级手动验证见 [VPS Hosting](/install/vps)。

  </Tab>
</Tabs>

<Note>
VPS Bash 命令在远程 VPS 内运行，不是在本地 PowerShell 中运行。Windows 管理
VPS 可以使用原生 Tailscale 和 SSH；只有 Fased 本地运行时才需要 WSL2。
</Note>

## 安装后

1. 在 **Agent > Models** 连接模型。
2. 在 **Chat** 发送测试消息。
3. 只有需要时才添加 channels、services、wallets 或 Mining。

中断后继续：

```bash
fased onboard --install-daemon
fased health
fased dashboard
```

正常更新：

```bash
fased update status
fased update
```

<AccordionGroup>
  <Accordion title="首次 curl 命令信任什么">
    首个脚本通过 HTTPS 从受保护的 `fased-ai/fased` GitHub 仓库下载。启动后，
    它固定一个 stable tag，并在特权 Fased 安装前验证 release manifest 和对应
    架构 bundle 的 GitHub attestation。

    需要在任何下载 shell 代码运行前验证 `install.sh` 的高级用户，可使用
    [手动执行前验证](/install/vps#advanced-exact-release-selection)。

  </Accordion>

  <Accordion title="支持边界">
    - Local：macOS、WSL2 Ubuntu 和常见 Linux。
    - VPS Hosting：带 systemd 的 Ubuntu、Fedora 和 RHEL-family Linux。
    - Docker：只支持 Local；不存在 `--hosting-docker`。
    - 原生 Windows：不支持；Local 使用 WSL2 Ubuntu。
  </Accordion>
</AccordionGroup>

## 更多指南

- [VPS Hosting](/install/vps)
- [Windows (WSL2)](/platforms/windows)
- [Installer Reference](/install/installer)
- [Docker Local](/install/docker)
- [更新](/install/updating)
- [卸载](/install/uninstall)
