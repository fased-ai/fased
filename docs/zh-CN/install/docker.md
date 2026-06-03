---
read_when:
  - 你想要容器化的 Gateway 网关而不是本地安装
  - 你正在验证 Docker 流程
summary: Fased 的可选 Docker 设置和新手引导
title: Docker
x-i18n:
  generated_at: "2026-02-03T07:51:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bd823e49b6ce76fe1136a42bf48f436b316ed1cd2f9612e3f4919f1e6b2cdee9
  source_path: install/docker.md
  workflow: 15
---

# Docker（可选）

Docker 是**可选的**。仅当你想要容器化的 Gateway 网关或验证 Docker 流程时才使用它。

## Docker 适合我吗？

- **是**：你想要一个隔离的、可丢弃的 Gateway 网关环境，或在没有本地安装的主机上运行 Fased。
- **否**：你在自己的机器上运行，只想要最快的开发循环。请改用正常的安装流程。
- **沙箱注意事项**：智能体沙箱隔离也使用 Docker，但它**不需要**完整的 Gateway 网关在 Docker 中运行。参阅[沙箱隔离](/gateway/sandboxing)。

本指南涵盖：

- 容器化 Gateway 网关（完整的 Fased 在 Docker 中）
- 每会话智能体沙箱（主机 Gateway 网关 + Docker 隔离的智能体工具）

沙箱隔离详情：[沙箱隔离](/gateway/sandboxing)

## 要求

- Docker Desktop（或 Docker Engine）+ Docker Compose v2
- 足够的磁盘空间用于镜像 + 日志

## 容器化 Gateway 网关（Docker Compose）

### 快速开始（推荐）

从仓库根目录：

```bash
./docker-setup.sh
```

此脚本：

- 构建 Gateway 网关镜像
- 运行新手引导向导
- 打印可选的提供商设置提示
- 通过 Docker Compose 启动 Gateway 网关
- 生成 Gateway 网关令牌并写入 `.env`

可选环境变量：

- `FASED_DOCKER_APT_PACKAGES` — 在构建期间安装额外的 apt 包
- `FASED_EXTRA_MOUNTS` — 添加额外的主机绑定挂载
- `FASED_HOME_VOLUME` — 在命名卷中持久化 `/home/node`

完成后：

- 在浏览器中打开 `http://127.0.0.1:18789/`。
- 将令牌粘贴到控制 UI（设置 → token）。
- 需要再次获取带令牌的 URL？运行 `docker compose run --rm fased-cli dashboard --no-open`。

它在主机上写入配置/工作区：

- `~/.fased/`
- `~/.fased/workspace`

在 VPS 上运行？参阅 [Hetzner（Docker VPS）](/install/hetzner)。

### 手动流程（compose）

```bash
docker build -t fased:local -f Dockerfile .
docker compose run --rm fased-cli onboard
docker compose up -d fased-gateway
```

注意：从仓库根目录运行 `docker compose ...`。如果你启用了 `FASED_EXTRA_MOUNTS` 或 `FASED_HOME_VOLUME`，设置脚本会写入 `docker-compose.extra.yml`；在其他地方运行 Compose 时包含它：

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 控制 UI 令牌 + 配对（Docker）

如果你看到"unauthorized"或"disconnected (1008): pairing required"，获取新的仪表板链接并批准浏览器设备：

```bash
docker compose run --rm fased-cli dashboard --no-open
docker compose run --rm fased-cli devices list
docker compose run --rm fased-cli devices approve <requestId>
```

更多详情：[仪表板](/web/dashboard)，[设备](/cli/devices)。

### 额外挂载（可选）

如果你想将额外的主机目录挂载到容器中，在运行 `docker-setup.sh` 之前设置 `FASED_EXTRA_MOUNTS`。这接受逗号分隔的 Docker 绑定挂载列表，并通过生成 `docker-compose.extra.yml` 将它们应用到 `fased-gateway` 和 `fased-cli`。

示例：

```bash
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 路径必须在 macOS/Windows 上与 Docker Desktop 共享。
- 如果你编辑 `FASED_EXTRA_MOUNTS`，重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- `docker-compose.extra.yml` 是生成的。不要手动编辑它。

### 持久化整个容器 home（可选）

如果你想让 `/home/node` 在容器重建后持久化，通过 `FASED_HOME_VOLUME` 设置一个命名卷。这会创建一个 Docker 卷并将其挂载到 `/home/node`，同时保持标准的配置/工作区绑定挂载。这里使用命名卷（不是绑定路径）；对于绑定挂载，使用 `FASED_EXTRA_MOUNTS`。

示例：

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

你可以将其与额外挂载结合使用：

```bash
export FASED_HOME_VOLUME="fased_home"
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

注意：

- 如果你更改 `FASED_HOME_VOLUME`，重新运行 `docker-setup.sh` 以重新生成额外的 compose 文件。
- 命名卷会持久化直到使用 `docker volume rm <name>` 删除。

### 安装额外的 apt 包（可选）

如果你需要镜像内的系统包（例如构建工具或媒体库），在运行 `docker-setup.sh` 之前设置 `FASED_DOCKER_APT_PACKAGES`。这会在镜像构建期间安装包，因此即使容器被删除它们也会持久化。

示例：

```bash
export FASED_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

注意：

- 这接受空格分隔的 apt 包名称列表。
- 如果你更改 `FASED_DOCKER_APT_PACKAGES`，重新运行 `docker-setup.sh` 以重建镜像。

### 高级用户/功能完整的容器（选择加入）

默认的 Docker 镜像较小，并以非 root 的 `node` 用户运行。这保持了较小的攻击面，但这意味着：

- 运行时无法安装系统包
- 默认没有 Homebrew
- 没有捆绑的 Chromium/Playwright 浏览器

如果你想要功能更完整的容器，使用这些选择加入选项：

1. **持久化 `/home/node`** 以便浏览器下载和工具缓存能够保留：

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

2. **将系统依赖烘焙到镜像中**（可重复 + 持久化）：

```bash
export FASED_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **不使用 `npx` 安装 Playwright 浏览器**（避免 npm 覆盖冲突）：

```bash
docker compose run --rm fased-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

如果你需要 Playwright 安装系统依赖，使用 `FASED_DOCKER_APT_PACKAGES` 重建镜像，而不是在运行时使用 `--with-deps`。

4. **持久化 Playwright 浏览器下载**：

- 在 `docker-compose.yml` 中设置 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`。
- 确保 `/home/node` 通过 `FASED_HOME_VOLUME` 持久化，或通过 `FASED_EXTRA_MOUNTS` 挂载 `/home/node/.cache/ms-playwright`。

### 权限 + EACCES

镜像以 `node`（uid 1000）运行。如果你在 `/home/node/.fased` 上看到权限错误，确保你的主机绑定挂载由 uid 1000 拥有。

示例（Linux 主机）：

```bash
sudo chown -R 1000:1000 /path/to/fased-config /path/to/fased-workspace
```

如果你选择以 root 运行以方便使用，你接受了安全权衡。

### 更快的重建（推荐）

要加速重建，排序你的 Dockerfile 以便依赖层被缓存。这避免了除非锁文件更改否则重新运行 `pnpm install`：

```dockerfile
FROM node:22-bookworm

# 安装 Bun（构建脚本需要）
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# 缓存依赖，除非包元数据更改
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### 渠道设置（可选）

使用 CLI 容器配置渠道，然后在需要时重启 Gateway 网关。

WhatsApp（QR）：

```bash
docker compose run --rm fased-cli channels login
```

Telegram（bot token）：

```bash
docker compose run --rm fased-cli channels add --channel telegram --token "<token>"
```

Discord（bot token）：

```bash
docker compose run --rm fased-cli channels add --channel discord --token "<token>"
```

文档：[WhatsApp](/channels/whatsapp)，[Telegram](/channels/telegram)，[Discord](/channels/discord)

### OpenAI Codex OAuth（无头 Docker）

如果你在向导中选择 OpenAI Codex OAuth，它会打开浏览器 URL 并尝试在 `http://127.0.0.1:1455/auth/callback` 捕获回调。在 Docker 或无头设置中，该回调可能显示浏览器错误。复制你到达的完整重定向 URL 并将其粘贴回向导以完成认证。

### 健康检查

```bash
docker compose exec fased-gateway node dist/index.js health --token "$FASED_GATEWAY_TOKEN"
```

### E2E 冒烟测试（Docker）

```bash
scripts/e2e/onboard-docker.sh
```

### QR 导入冒烟测试（Docker）

```bash
pnpm test:docker:qr
```

### 注意

- Gateway 网关绑定默认为 `lan` 用于容器使用。
- Dockerfile CMD 使用 `--allow-unconfigured`；挂载的配置如果 `gateway.mode` 不是 `local` 仍会启动。覆盖 CMD 以强制执行检查。
- Gateway 网关容器是会话的真实来源（`~/.fased/agents/<agentId>/sessions/`）。

## 智能体沙箱（主机 Gateway 网关 + Docker 工具）

深入了解：[沙箱隔离](/gateway/sandboxing)

这和“整个 Gateway 跑在 Docker 里”是两件事。Gateway 可以在主机上运行，
同时让选定工具会话在 Docker 容器内执行。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.fased/sandboxes",
        docker: {
          image: "fased-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "fased-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 禁用空闲清理
          maxAgeDays: 7, // 0 禁用最大年龄清理
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

关键默认行为：

- 默认每个 Agent 一个 sandbox；
- sandbox workspace 在 `~/.fased/sandboxes`；
- Docker 网络默认关闭；
- host browser/camera/canvas 默认阻止；
- `deny` 工具策略优先于 `allow`；
- `scope: "shared"` 会禁用跨会话隔离。

完整优先级、浏览器 sandbox、per-agent override 和加固选项见
[沙箱隔离](/gateway/sandboxing) 与
[多智能体沙箱与工具](/tools/multi-agent-sandbox-tools)。

### 构建默认沙箱镜像

```bash
scripts/sandbox-setup.sh
```

这使用 `deploy/containers/Dockerfile.sandbox` 构建 `fased-sandbox:bookworm-slim`。

### 可选沙箱镜像

如果你想要一个带有常见构建工具（Node、Go、Rust 等）的沙箱镜像，构建通用镜像：

```bash
scripts/sandbox-common-setup.sh
```

这构建 `fased-sandbox-common:bookworm-slim`。要使用它：

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "fased-sandbox-common:bookworm-slim" } },
    },
  },
}
```

要在沙箱内运行浏览器工具，构建浏览器镜像：

```bash
scripts/sandbox-browser-setup.sh
```

### 自定义沙箱镜像

构建你自己的镜像并将配置指向它：

```bash
docker build -t my-fased-sbx -f deploy/containers/Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-fased-sbx" } },
    },
  },
}
```

### 隔离说明

- 硬隔离仅适用于**工具**（exec/read/write/edit/apply_patch）。
- 仅主机工具如 browser/camera/canvas 默认被阻止。
- 在沙箱中允许 `browser` **会破坏隔离**（浏览器在主机上运行）。

## 故障排除

- 镜像缺失：使用 [`scripts/sandbox-setup.sh`](https://github.com/fased-ai/fased/blob/main/scripts/sandbox-setup.sh) 构建或设置 `agents.defaults.sandbox.docker.image`。
- 容器未运行：它会按需为每个会话自动创建。
- 沙箱中的权限错误：将 `docker.user` 设置为与你挂载的工作区所有权匹配的 UID:GID（或 chown 工作区文件夹）。
- 找不到自定义工具：Fased 使用 `sh -lc`（登录 shell）运行命令，这会 source `/etc/profile` 并可能重置 PATH。设置 `docker.env.PATH` 以在前面添加你的自定义工具路径（例如 `/custom/bin:/usr/local/share/npm-global/bin`），或在你的 Dockerfile 中在 `/etc/profile.d/` 下添加脚本。
