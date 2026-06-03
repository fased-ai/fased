---
title: "安全"
summary: "自托管 Fased Gateway 的安全模型和加固指南。"
read_when:
  - 新功能会扩大访问或自动化能力
  - Gateway 准备暴露到 loopback 之外
  - 审查 tool、channel、node、browser 或 plugin 权限
---

# 安全

> [!WARNING]
> Fased 假设一个 Gateway 属于一个可信 operator 边界。它不是给互相敌对的用户共享同一个 Gateway、host、凭证或 Agent 的多租户安全边界。

本页用于决定谁可以访问 Gateway、谁可以给 Agent 发消息、Agent 可以使用哪些工具，以及出现异常后怎么处理。

## 信任模型

推荐模型：

- 每个 Gateway 对应一个用户或可信团队边界；
- 尽量每个信任边界使用独立 OS 用户、host 或 VPS；
- 不同信任边界使用独立凭证、workspace 和 browser profile；
- 混合信任用户应拆成不同 Gateway。

在一个 Gateway 内，已认证 operator 访问就是控制平面访问。
`sessionKey` 是路由和上下文选择器，不是授权 token。每用户 session
隔离可以减少上下文串扰，但不能把共享 Gateway 变成敌对多租户平台。

## 快速审计

```bash
fased security audit
fased security audit --deep
fased security audit --fix
fased security audit --json
```

审计会检查：

- Gateway bind/auth 暴露；
- DM 和 group policy；
- 过宽 tool 或 elevated-tool 权限；
- browser/node 暴露；
- 本地文件权限；
- plugin 没有显式 allowlist；
- 风险 debug flags；
- sandbox 配了但没有真正启用。

## 推荐基线

先保持私有，再逐步放宽：

```json5
{
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: "replace-with-long-random-token" },
  },
  session: {
    dmScope: "per-channel-peer",
  },
  tools: {
    profile: "messaging",
    deny: ["group:automation", "group:runtime", "group:fs", "sessions_spawn", "sessions_send"],
    fs: { workspaceOnly: true },
    exec: { security: "deny", ask: "always" },
    elevated: { enabled: false },
  },
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 网络暴露

推荐顺序：

1. `gateway.bind: "loopback"` 加 token auth。
2. Tailscale Serve、tailnet 直连或 SSH tunnel。
3. 显式配置 `gateway.trustedProxies` 的 trusted reverse proxy。
4. 只有在明确需要、已认证、已防火墙限制时才使用 LAN/custom bind。

避免：

- 未认证的 `0.0.0.0`；
- 直接把原始 Gateway 端口暴露到公网；
- 从自定义 proxy 转发 Tailscale identity headers；
- 把 `sessionKey` 当作授权边界。

## Control UI Auth

Control UI 需要 HTTPS 或 localhost 这样的安全浏览器上下文。

关键设置：

- `gateway.auth.mode: "token"`
- `gateway.auth.mode: "password"`
- `gateway.auth.mode: "trusted-proxy"`
- `gateway.controlUi.allowInsecureAuth`：仅本地兼容开关。
- `gateway.controlUi.dangerouslyDisableDeviceAuth`：仅临时 break-glass。

## DM 和群组访问

DM policy：

| Policy      | 含义                                           |
| ----------- | ---------------------------------------------- |
| `pairing`   | 未知 sender 收到 pairing code，operator 审批。 |
| `allowlist` | 只允许配置或已审批 sender。                    |
| `open`      | 任何人可 DM，需要显式 `"*"`。                  |
| `disabled`  | 忽略 inbound DM。                              |

群组通常应使用 allowlist 加 mention gating。公共或多人房间不应配宽工具权限。

多人可 DM 同一个 Agent 时：

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

同一 channel 多账号时使用 `per-account-channel-peer`。

## 工具权限

高影响面：

- `exec` / `process`
- 文件读写编辑和 `apply_patch`
- browser control
- `gateway` config/update calls
- `cron` / task 创建
- session tools
- node commands，例如 camera、screen、contacts、calendar、SMS、shell

读取不可信内容的 Agent 可以从这个策略开始：

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send", "exec", "process"],
    fs: { workspaceOnly: true },
  },
}
```

## Sandboxing

Sandboxing 是工具执行边界，不替代 channel access control。

常见选择：

- 整个 Gateway 运行在 Docker；
- host Gateway 加 Docker-isolated tools；
- 对不需要写权限的 Agent 使用 `workspaceAccess: "none"` 或 `"ro"`；
- 使用 `scope: "agent"` 或 `"session"`。

如果 sandbox mode 关闭，`exec` 会在 Gateway host 上运行，除非 tool policy
拒绝或 exec approval 阻止。

## Browser 和 Node Control

Browser control 可以操作所选 browser profile。该 profile 如果已经登录服务，
Agent 可能能访问这些会话。

建议：

- 给 Fased 使用独立 browser profile；
- 避免使用个人 daily-driver profile；
- Gateway 和 node host 只走 tailnet；
- 不需要时关闭 browser proxy routing；
- 有意配对 node，并把 node pairing 视为 operator 级访问。

## Prompt Injection

System prompt 不能单独解决 prompt injection。把不可信消息、链接、文件、邮件、网页和附件都当作可能携带对抗性指令。

硬控制更重要：

- pairing / allowlists；
- group mention gates；
- 最小工具权限；
- sandboxing；
- 限制文件根目录；
- tool-enabled Agent 使用较强模型；
- 对不可信内容先用 reader/summarizer Agent，再把摘要交给更高权限 Agent。

保持这些外部内容 bypass flags 关闭，除非是短时调试：

- `hooks.mappings[].allowUnsafeExternalContent`
- `hooks.gmail.allowUnsafeExternalContent`
- cron payload field `allowUnsafeExternalContent`

## Secrets、Logs 和 Transcripts

把这些视为私有：

- `~/.fased/fased.json`
- `~/.fased/credentials/**`
- `~/.fased/agents/<agentId>/agent/auth-profiles.json`
- `~/.fased/secrets.json`
- `~/.fased/agents/<agentId>/sessions/**`
- `~/.fased/extensions/**`
- `~/.fased/sandboxes/**`

建议：

- 目录 `700`，私有文件 `600`；
- 启用磁盘加密；
- 保持 `logging.redactSensitive` 开启；
- 分享诊断前先审查；
- 不需要长期保留时清理旧 logs/transcripts。

## Plugins 和动态 Skills

Plugins 和动态 skills 是可信代码：

- 只安装可信来源；
- 优先使用 `plugins.allow`；
- 启用前审查 plugin config；
- 从 registry 安装时 pin 版本；
- plugin 变更后重启 Gateway；
- 限制谁能修改 skill folders。

## Incident Response

如果 Agent 做了异常动作：

1. 停止 Gateway 或 app supervisor。
2. 关闭暴露：改回 `gateway.bind: "loopback"`。
3. 冻结风险 channel：`dmPolicy: "disabled"` 或更严格 allowlist。
4. 轮换 Gateway auth 和 remote client 凭证。
5. 如有泄露可能，轮换 provider/channel/model 凭证。
6. 审查 logs、session transcripts 和最近 config 变更。
7. 运行 `fased security audit --deep`。

## 安全报告

使用仓库安全策略：

- [`SECURITY.md`](https://github.com/fased-ai/agent/blob/main/SECURITY.md)

不要在公开 issue 中发布 secrets、私有基础设施细节或实时 exploit 材料。

## 相关

- [Authentication](/gateway/authentication)
- [Trusted Proxy Auth](/gateway/trusted-proxy-auth)
- [Sandboxing](/gateway/sandboxing)
- [Session Management](/concepts/session)
- [Logging](/gateway/logging)
- [Secrets](/gateway/secrets)
