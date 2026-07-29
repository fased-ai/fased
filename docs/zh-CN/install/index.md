---
summary: "在自己的电脑或全新常在线 VPS 上安装 Fased。"
read_when:
  - 你要安装 Fased
  - 你需要在 Local 与 VPS Hosting 之间选择
title: "安装"
---

# 安装

只选择一种运行方式。Local 在你的电脑上运行；VPS Hosting 在远程 Linux
服务器上持续在线。

<Tabs>
  <Tab title="Local">
    在 macOS Terminal、Linux 终端或 Ubuntu WSL2 shell 中运行：

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --local
    ```

    原生 Windows 不是 Local 运行环境。请在
    [WSL2 Ubuntu](/platforms/windows) 内运行 Fased，不要在 PowerShell、
    Command Prompt、Git Bash 或原生 Windows Node.js 中运行。Local 可选用
    Tailscale。

  </Tab>

  <Tab title="VPS Hosting">
    最简单的路径是全新 Ubuntu LTS VPS。SSH 进入 VPS 的 root shell 后，
    原样运行：

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
      | bash -s -- --hosting
    ```

    安装器会先选择并验证一个稳定 tag 的 Hosting release，再创建持久化
    Fased 状态。Tailscale 与 SSH 步骤见 [VPS 三步安装](/install/vps)。

  </Tab>
</Tabs>

<Note>
VPS 命令在 VPS provider 的 root shell 中运行。Windows 用户可以在
PowerShell 中管理 VPS；只有在 Windows 本机运行 Fased Local 时才需要 WSL2。
</Note>

## 安装后

1. 在 **Agent > Models** 连接模型。
2. 在 **Chat** 发送测试消息。
3. 需要时再添加 channel、wallet、skill 或 Mining。

```bash
fased health
fased dashboard
```

正常更新：

```bash
fased update
```

<AccordionGroup>
  <Accordion title="Local 与 Hosting 的区别">
    | 路径 | 运行位置 | 私有访问 | 正常操作身份 |
    | --- | --- | --- | --- |
    | Local | macOS、Linux 或 WSL2 Ubuntu | 本机 OS；Tailscale 可选 | 你的 OS 账号 |
    | VPS Hosting | Ubuntu/Fedora/RHEL-family systemd VPS | Tailscale，加 provider console 恢复 | `app`；Gateway 隔离为 `fased-gateway` |
  </Accordion>

  <Accordion title="streamed 安装器信任什么">
    安装命令从最新的不可变稳定 GitHub Release 下载 `install.sh`。发布自动化
    会在证明前写入精确版本并拒绝覆盖已发布资产；未写入版本的流式脚本会在
    安装前退出。Fresh Hosting 路径继续验证 release workflow、tag、signed
    manifest、app、dependency、supervisor/controller、signer、architecture、
    commit、digest 与 archive layout。

    如需在 Bash 执行前验证 `install.sh`，使用
    [Advanced Installer](/install/installer) 中的 exact-tag 流程。

  </Accordion>

  <Accordion title="中断或修复">
    streamed `--hosting` 只用于全新安装。正常更新使用已安装 updater；已有
    Hosting 的修复必须使用 exact-tag 流程，见
    [Hosting 修复与恢复](/install/installer)。
  </Accordion>
</AccordionGroup>
