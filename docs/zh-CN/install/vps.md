---
summary: "用三步在全新 VPS 安装 Fased，并通过 Tailscale 私有访问。"
read_when:
  - 你要让 Fased 在 VPS 持续运行
  - 你需要 Hosting 访问或恢复说明
title: "VPS Hosting"
---

# VPS Hosting

最简单的支持路径是全新 Ubuntu LTS VPS。Fased 会从操作系统的签名软件源
安装 VPS 端 Tailscale；不要运行 Tailscale 的远程 `curl | sh` 安装器。

## 三步安装

### 1. 准备自己的电脑

在你将使用 Fased 的电脑安装并登录
[Tailscale app](https://tailscale.com/download)。保留 VPS provider console
作为恢复通道。

### 2. 连接全新 VPS

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

下一条命令在 VPS root shell 中运行，不是在本机未连接 SSH 的 PowerShell 中。

### 3. 安装 Fased

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --hosting
```

在自己的电脑打开安装器打印的 Tailscale 登录 URL。提示确认前，先验证私有
SSH 连接。

## 安装后

以 human operator 身份重新连接，不要继续使用 root，也不要使用 Gateway
service account：

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased health
fased dashboard
```

`app` operator 只能使用受限 signer lifecycle socket；`fased-gateway` 运行
Gateway，不能使用 operator 权限。正常更新同样由 operator 执行：

```bash
fased update status
fased update
```

<AccordionGroup>
  <Accordion title="这条命令验证什么">
    streamed script 只接受全新 `--hosting`。它拒绝 repair、release/source
    override、调用方 verification marker、不安全的 proxy/shell override 和
    已存在的 Fased 状态。

    持久化修改之前，它验证 release manifest 的离线 GitHub attestation
    bundle。manifest 绑定 workflow、tag、source commit、architecture、app、
    dependency 与 signer digest；同时检查 archive path、link、owner、可写
    mode、package version 和 build identity。

    首次 mutable `main/install.sh` 下载仍是 bootstrap 信任。如需在任何 shell
    执行前验证，使用下面的 exact-tag Advanced 流程。

  </Accordion>

  <Accordion title="Advanced：执行前验证 install.sh">
    使用操作系统签名软件源安装 GitHub CLI，然后遵循
    [Advanced Installer exact-tag 流程](/install/installer)。这是唯一支持
    Hosting release override 的文档路径。
  </Accordion>

  <Accordion title="Hosting 修复与恢复">
    不要从 `main` pipe `--repair-hosting`。在 provider root console 中先完成
    Advanced Installer 的 exact-tag 验证，再运行：

    ```bash
    bash "$BOOTSTRAP_DIR/install.sh" --repair-hosting --release "$RELEASE"
    ```

    如果 fresh streamed 安装在 `/var/lib/fased-installer` 出现前停止，修复
    报错后重跑正常命令。若已存在持久化 installer 状态，则使用 exact-tag
    repair。

  </Accordion>

  <Accordion title="Tailscale、VPN 与 MagicDNS 排查">
    测试时先关闭其他 VPN。在自己的电脑运行：

    ```bash
    tailscale status
    tailscale ping YOUR_VPS_TAILSCALE_NAME
    ssh app@YOUR_VPS_TAILSCALE_NAME
    ssh app@100.x.x.x
    ```

    `no matching peer` 通常表示设备不在同一 tailnet。只有 hostname 失败通常
    是其他 VPN 或 DNS 覆盖 MagicDNS。普通 SSH key 不可用时，可尝试
    `tailscale ssh app@YOUR_VPS_TAILSCALE_NAME`。

  </Accordion>

  <Accordion title="最小镜像与支持范围">
    Ubuntu 或 Debian：

    ```bash
    apt-get update
    apt-get install -y curl ca-certificates
    ```

    Fedora 或 RHEL family：

    ```bash
    dnf install -y curl ca-certificates
    ```

    Hosting hardening 支持带 systemd 的 Ubuntu、Fedora 与 RHEL-family Linux。
    至少使用 25 GB 磁盘；2 GB RAM 是较实用的小型节点配置。

  </Accordion>
</AccordionGroup>
