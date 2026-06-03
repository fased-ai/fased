---
read_when:
  - 你希望以最快的方式从安装到运行一个可用的 Gateway 网关
summary: 安装 Fased，完成 Gateway 网关新手引导，并配对你的第一个渠道。
title: 快速开始
x-i18n:
  generated_at: "2026-02-04T17:53:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3c5da65996f89913cd115279ae21dcab794eadd14595951b676d8f7864fbbe2d
  source_path: start/quickstart.md
  workflow: 15
---

<Note>
Fased 推荐 Node 24，最低需要带 `node:sqlite` 的 Node 22.14+。
</Note>

## 安装

<Tabs>
  <Tab title="仓库安装（推荐）">
    ```bash
    git clone https://github.com/fased-ai/fased.git fased
    cd fased
    ./install.sh
    ```
  </Tab>
</Tabs>

## 新手引导并运行 Gateway 网关

<Steps>
  <Step title="新手引导并安装服务">
    ```bash
    fased onboard --install-daemon
    ```

    `./install.sh` 默认会运行新手引导；这条命令用于 `--no-onboard`、中断恢复或重新配置。

  </Step>
  <Step title="配对 WhatsApp">
    ```bash
    fased channels login
    ```
  </Step>
  <Step title="启动 Gateway 网关">
    ```bash
    fased gateway --port 18789
    ```
  </Step>
</Steps>

完成新手引导后，Gateway 网关将通过用户服务运行。你也可以使用 `fased gateway` 手动启动。

<Info>
公开安装路径目前是仓库安装器。包管理器全局安装不是正常公开路径。
</Info>

## 从源码安装（开发）

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
pnpm install
pnpm ui:build # 首次运行时会自动安装 UI 依赖
pnpm build
./install.sh --no-onboard
fased onboard --install-daemon
```

如果 `fased` 命令缺失，请先在仓库目录运行 `./install.sh --no-onboard`。

## 多实例快速开始（可选）

```bash
FASED_CONFIG_PATH=~/.fased/a.json \
FASED_STATE_DIR=~/.fased-a \
fased gateway --port 19001
```

## 发送测试消息

需要一个正在运行的 Gateway 网关。

```bash
fased message send --target +15555550123 --message "Hello from Fased"
```
