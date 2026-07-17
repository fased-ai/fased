---
summary: "Fased 支持的本地 Docker 安装与更新流程"
read_when:
  - 你想在自己的电脑上用容器运行 Fased
  - 你正在验证 Docker 流程
title: "Docker"
---

# 本地 Docker（可选）

完整的 Docker Gateway **只支持本地电脑**。Fased 目前不支持在 VPS 或云服务器上
托管完整 Docker Gateway，也不存在 `install.sh --hosting-docker`。

如果要让 Fased 在 VPS 上常驻运行，请使用由主机管理的非 Docker
[`install.sh --hosting`](/install/vps) 流程。它负责独立原生签名器、root 更新器、
systemd、Tailscale、SSH/防火墙加固以及协调更新和回滚。本地 Docker 不提供这些
托管安全边界，不能代替 Hosting 安装。

## 系统要求

- Linux：在 Bash 中运行。
- macOS：在 Terminal 中运行；Docker 会使用 Linux 签名器镜像。
- Windows：需要 Windows 11，或 Windows 10 2004/build 19041 及以上版本，
  WSL2 Ubuntu，以及启用了 WSL2 后端和 Ubuntu 集成的 Docker Desktop。所有
  Fased 命令都必须在 **Ubuntu WSL2 shell** 中运行，不能在 PowerShell、CMD、
  Git Bash 或原生 Windows Node.js 中运行。
- 当前 Docker Compose v2，以及足够的镜像和日志空间。

PowerShell 只用于一次性安装或检查 WSL2：

```powershell
wsl --install -d Ubuntu
wsl --update
wsl --list --verbose
```

按提示重启 Windows，打开 Ubuntu，完成 Linux 用户设置，并在 Docker Desktop 的
**Settings > Resources > WSL Integration** 中启用该 Ubuntu 发行版。然后回到
Ubuntu shell，确认 `docker version` 和 `docker compose version` 均成功。

## 从公开镜像安装（推荐）

从 [GitHub Releases](https://github.com/fased-ai/fased/releases) 选择最新稳定版本，
并让仓库 tag 和镜像 tag 保持一致：

```bash
export FASED_VERSION="<stable-version>"
git clone --branch "v${FASED_VERSION}" --depth 1 https://github.com/fased-ai/fased.git fased
cd fased
FASED_IMAGE="ghcr.io/fased-ai/fased:${FASED_VERSION}" ./docker-setup.sh
```

`ghcr.io/fased-ai/fased` 公开支持匿名拉取 `linux/amd64` 和 `linux/arm64`；用户不需要
Docker Hub/GitHub 账户、token 或 `docker login`。生产可复现安装应使用稳定版本 tag
或发布元数据中验证过的 manifest digest；`latest` 仅用于方便测试。

`docker-setup.sh` 会在任何钱包操作前启动并检查同版本的原生 `fased-signerd`，运行
onboarding，生成仅本用户可读的 `.env`，启动并健康检查 Gateway。

## 钱包和本地安全边界

设置钱包时使用：

```bash
docker compose run --rm fased-cli wallet setup --chain solana
```

Compose 将签名器状态、应用 socket 和管理 socket 分开；Gateway 只能访问受策略限制
的应用 socket。服务以非 root 用户运行、丢弃 Linux capabilities、启用
`no-new-privileges`，并只把 Gateway 端口绑定到 `127.0.0.1`。

这仍然只是**本地容器隔离**，不是 Hosting 的主机级托管边界。拥有本机账户或 Docker
daemon 权限的人仍可控制容器和卷。Agent/Mining 钱包应保持低余额并配置明确的 typed
操作、目标和正数额度；Vault/储备资金应使用硬件钱包或经审查的远程托管提供商。

不要把端口改为 `0.0.0.0`，不要挂载 `docker.sock`，不要使用 host network 或
privileged 模式。不要运行 `docker compose down -v`，除非你明确要永久删除签名器
状态和钱包。

## 更新与回滚

不要在容器内运行 `fased update`，也不要只修改 `.env` 后手动重建。先从发布元数据
取得 manifest digest、release commit 和 signer build-input digest。先从系统可信包源
安装 GitHub CLI 并确认 `gh version`，再验证精确 tag 的 metadata 和 OCI attestation：

```bash
cd /path/to/fased
RELEASE=vX.Y.Z
VERIFY_DIR="$(mktemp -d)"
chmod 0700 "$VERIFY_DIR"
for ASSET in \
  "fased-container-${RELEASE}.json" \
  "fased-container-${RELEASE}.attestation.json" \
  "fased-container-${RELEASE}.image-attestation.json"; do
  curl -fsSLo "$VERIFY_DIR/$ASSET" \
    "https://github.com/fased-ai/fased/releases/download/${RELEASE}/${ASSET}"
done
GH_PROMPT_DISABLED=1 gh attestation verify \
  "$VERIFY_DIR/fased-container-${RELEASE}.json" \
  --repo fased-ai/fased \
  --bundle "$VERIFY_DIR/fased-container-${RELEASE}.attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/docker-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners
MANIFEST_DIGEST="$(sed -n 's/.*"manifestDigest": "\(sha256:[a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
RELEASE_COMMIT="$(sed -n 's/.*"releaseCommit": "\([a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
SIGNER_BUILD_INPUT_DIGEST="$(sed -n 's/.*"signerBuildInputDigest": "\(sha256:[a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
[[ "$MANIFEST_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]]
[[ "$SIGNER_BUILD_INPUT_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
GH_PROMPT_DISABLED=1 gh attestation verify \
  "oci://ghcr.io/fased-ai/fased@${MANIFEST_DIGEST}" \
  --repo fased-ai/fased \
  --bundle "$VERIFY_DIR/fased-container-${RELEASE}.image-attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/docker-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners
mkdir -p "$HOME/.local/state/fased/docker-signer-backups"
scripts/docker-signer-update.sh \
  --image "ghcr.io/fased-ai/fased@${MANIFEST_DIGEST}" \
  --expected-release-commit "$RELEASE_COMMIT" \
  --expected-signer-build-input-digest "$SIGNER_BUILD_INPUT_DIGEST" \
  --snapshot-dir "$HOME/.local/state/fased/docker-signer-backups/pre-${RELEASE}"
rm -rf "$VERIFY_DIR"
```

任何下载、attestation、解析或 identity 检查失败都必须停止。更新器在停止服务前比较
镜像内的 commit/build-input identity；之后停止 Gateway/签名器并验证、快照离线 signer
volume，安装精确 Compose/image 配对，再启动并健康检查新 signer 和 Gateway。任何失败会恢复
已验证的旧 app/signer/state 配对；不会在不确定状态下静默继续。

## Agent 沙箱与完整 Docker Gateway 不同

主机上用 `install.sh --hosting` 管理 Gateway 的同时，可以安装 Docker 仅用于可选的
每会话 Agent 沙箱。那不会把 Gateway 或签名器迁入 Docker，也不会改变 Hosting 的
主机级生命周期。参阅[沙箱隔离](/gateway/sandboxing)。
