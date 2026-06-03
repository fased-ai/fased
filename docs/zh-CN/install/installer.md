---
read_when:
  - 你想了解 `install.sh`
  - 你要在自动化环境中安装
  - 你想确认仓库安装的真实流程
summary: 仓库安装脚本 `install.sh` 的行为、常用参数和自动化方式
title: 安装器内部机制
x-i18n:
  generated_at: "2026-04-21T00:00:00Z"
  model: manual
  provider: codex
  source_path: install/installer.md
---

# 安装器内部机制

当前这套文档只记录仓库里真实存在的安装器：

- [`install.sh`](https://github.com/fased-ai/fased/blob/main/install.sh)

从零开始的真实路径是：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
```

<Note>
Windows 请先安装
[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)，
然后在 Ubuntu 中运行同样的仓库命令。
</Note>

## `install.sh` 会做什么

<Steps>
  <Step title="检测主机环境">
    支持 macOS、Linux 和 WSL2。
  </Step>
  <Step title="确保兼容的 Node.js 运行时">
    Fased 推荐 Node 24，并要求 Node 22.14 或更新版本且带有内置
    `node:sqlite` 模块。在支持的 Linux 主机上，启用自动安装时安装器可以安装缺失依赖。
  </Step>
  <Step title="确保 Git 可用">
    需要从仓库检出或更新。
  </Step>
  <Step title="准备仓库运行时">
    使用当前公开支持的仓库 checkout 安装流程。
  </Step>
  <Step title="按需运行新手引导">
    如果没有跳过，新手引导会交给 `fased onboard --install-daemon`。
  </Step>
  <Step title="通过 Sync 写入 SAT 运行时 id">
    预发布安装会保持 `config/sat-runtime.env` 为空。Satcoin mainnet proof
    发布后，在 Mining 页面使用 Sync 验证签名 manifest，并写入官方 SAT ids。
  </Step>
</Steps>

## 最常用命令

```bash
./install.sh
```

```bash
./install.sh --help
```

```bash
./install.sh --no-onboard
```

```bash
./install.sh --verbose
```

## 常见模式

<Tabs>
  <Tab title="默认">
    ```bash
    ./install.sh
    ```

    默认会运行新手引导。

  </Tab>
  <Tab title="跳过新手引导">
    ```bash
    ./install.sh --no-onboard
    ```
  </Tab>
  <Tab title="托管配置">
    ```bash
    ./install.sh --hosting
    ```
  </Tab>
  <Tab title="本地配置">
    ```bash
    ./install.sh --local
    ```
  </Tab>
  <Tab title="详细日志">
    ```bash
    ./install.sh --verbose
    ```
  </Tab>
</Tabs>

## 主要参数

| 参数                   | 说明                          |
| ---------------------- | ----------------------------- |
| `--auto-install`       | 在支持的 Linux 上自动安装依赖 |
| `--no-auto-install`    | 不自动安装缺失依赖            |
| `--install-dir <path>` | 指定 checkout/安装目录        |
| `--hosting`            | 使用托管/VPS 新手引导默认值   |
| `--local`              | 使用本地机器新手引导默认值    |
| `--swap-gb <n>`        | 为小内存 Linux 主机配置 swap  |
| `--no-onboard`         | 构建/安装后跳过新手引导       |
| `--verbose`            | 显示安装命令输出              |
| `--help`               | 显示帮助                      |

`--` 后面的额外参数会转发给 `fased onboard --install-daemon`。

## 环境变量

| 变量                                | 说明                              |
| ----------------------------------- | --------------------------------- |
| `FASED_INSTALL_REPO=<url>`          | bootstrap 使用的仓库 URL          |
| `FASED_INSTALL_DIR=<path>`          | checkout/安装目录                 |
| `FASED_CONFIG_DIR=<path>`           | 配置、安装标记、缓存和日志目录    |
| `FASED_CLI_BIN_DIR=<path>`          | `install.sh` 写入 `fased` 的目录  |
| `FASED_INSTALL_VERBOSE=1`           | 显示安装命令输出                  |
| `FASED_INSTALL_USER=<name>`         | root bootstrap 使用的非 root 用户 |
| `FASED_SAT_RUNTIME_ENV_FILE=<path>` | 安装和新手引导读取的 SAT env 文件 |

## 自动化

无头安装：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --no-onboard
```

在 CI 或受控主机上指定安装目录：

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --install-dir "$HOME/agent" --no-onboard
```

## 暂未作为公开安装路径

直接 `npm install -g`、`pnpm add -g` 或 Bun 全局包安装不是当前公开设置路径。
等包发布和发布自动化准备好后，这些路径可以重新加入。现在支持的公开路径仍然是仓库安装器。

## 相关页面

- [安装](/install)
- [更新](/install/updating)
- [Docker](/install/docker)
- [CLI 新手引导](/cli/onboard)
