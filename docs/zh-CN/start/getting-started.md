---
summary: "安装 Fased 并发送第一条浏览器消息。"
read_when:
  - 你第一次设置 Fased
  - 你想用最短路径完成聊天
title: "开始使用"
---

# 开始使用

## 1. 安装

<Tabs>
  <Tab title="Local">
    在 macOS Terminal、Linux 终端或 Ubuntu WSL2 中运行：

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh | bash -s -- --local
    ```

    原生 Windows 使用 [WSL2 Ubuntu](/platforms/windows)。不要在 PowerShell
    或原生 Windows Node.js 中运行这条 Bash 命令。

  </Tab>

  <Tab title="VPS Hosting">
    先在自己的电脑登录 Tailscale。SSH 进入全新 VPS 的 root shell 后运行：

    ```bash
    curl -fsSL https://github.com/fased-ai/fased/releases/latest/download/install.sh \
      | bash -s -- --hosting
    ```

    私有 SSH 检查与恢复边界见 [VPS Hosting](/install/vps)。

  </Tab>
</Tabs>

安装器会运行 onboarding。如之前跳过或中断：

```bash
fased onboard --install-daemon
```

## 2. 打开 Fased

```bash
fased health
fased dashboard
```

Hosting 上先通过 Tailscale 以 `app` operator 重新连接。Gateway 本身由隔离的
`fased-gateway` 账号运行。

## 3. 连接模型

在 Control UI 中：

1. 打开 **Agent > Models**。
2. 登录或添加一个 provider API key。
3. 选择 Agent 的 primary model。

## 4. 发送第一条消息

打开 **Chat**，选择同一个 Agent，然后发送：

```text
Reply with one sentence: Fased is ready.
```

失败时先检查 **Agent > Models**，再检查 **Logs**。

<Check>
浏览器收到回复后，first-run 流程完成。
</Check>

## 按需添加

<AccordionGroup>
  <Accordion title="账号与运行边界">
    Local 在你的 OS 账号下运行。Hosting 分离 human `app` operator、
    `fased-gateway` service 和 `fased-signer` service。root 只用于首次
    bootstrap 与 exact-tag emergency repair。
  </Accordion>

  <Accordion title="以后更新">
    ```bash
    fased update status
    fased update
    ```

    默认跟随 stable release tag；development channel 需要明确 opt-in。

  </Accordion>

</AccordionGroup>
