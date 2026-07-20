---
title: "安全概览"
summary: "远程访问、凭证、Skills、钱包授权和运维页面的安全优先设置指南。"
read_when:
  - 准备公开或托管 Fased 安装
  - 审查 skill、钱包、服务凭证或远程访问风险
  - 解释普通设置页和运维诊断页的边界
---

# 安全概览

Fased 是自托管智能体运行时。请把它当作一个能访问聊天、工具、凭证、文件、钱包和可选远程节点的本地服务器。更保守的模型是把每种能力放在单独 gate 后面：先连接服务，再允许 Agent 使用工具，敏感动作再单独审批。

## 普通设置页面

优先使用选定 Agent：

- **Agent > Models**：连接模型认证并选择 primary/fallback/task 模型。
- **Agent > Channels**：配置聊天 app 并把消息路由到该 Agent。
- **Agent > Services**：连接 web search、GitHub、Gmail、media、自定义 API 等服务。
- **Agent > Skills**：审查/安装 skills、配置值、安装依赖、测试加载并允许该 Agent 使用。
- **Agent > Tools**：允许或阻止该 Agent 使用已经存在的工具。
- **Agent > Memory**：查看该 Agent 的 session-memory 状态和 roots。
- **Agent > Tasks**：安排以该 Agent 运行的工作。

运维页面是分开的：

- **Usage**：本地 token/cost 历史。
- **Logs**：Gateway log tail。
- **Advanced**：Config、Debug、Nodes，用于原始设置和诊断。

## 远程访问

推荐模式：

- 本地：绑定 loopback，打开 `http://localhost:18789`。
- 私有远程：使用 Tailscale 或 SSH tunnel。
- 公共托管：启用 Gateway auth，在 Gateway 前放 TLS，并用防火墙只暴露必要端口。

不要在没有 auth 的情况下把 Gateway 绑定到公网接口。浏览器远程访问优先使用 Tailscale/private networking。

VPS Hosting 分离权限：`app` 是 human operator；`fased-gateway` 是只能使用
application signer 操作的 non-login service；`fased-signer` 拥有 key、policy、
network state 与 signer audit；root 只用于首次 bootstrap 与 exact-tag emergency
repair。正常 streamed Hosting 只用于 fresh install，并在创建持久化 Fased
状态、账号或 service 前验证 tagged manifest 与 app/dependency/signer layer。

## Skills 和插件发现

Skill 是 `SKILL.md` 指令包，加可选配置和依赖。安装 skill 只表示 Fased 在 library 或工作区里有这个文件；不代表依赖、API key、钱包访问或 Agent access 已经 ready。

保守流程：

1. 审查来源：内置、工作区、共享 library 或插件目录。
2. 安装或复制 skill 文件。
3. 在 Agent > Skills 中配置值。
4. 运行依赖安装前检查包管理器、确切命令、pin/integrity 和 PATH 目标。
5. 安装后验证 Gateway 进程能看到所需二进制。
6. 允许选定 Agent 使用该 skill。
7. 需要工具或钱包时分别授权。

## 钱包、Mining 和 Skill Grants

钱包访问与 skills 和 tools 分开。

- 钱包设置和审批在 **Wallets**。
- 通用 wallet-capable skills 只能使用显式允许的 Agent-role wallet。
- Mining 和 Vault 钱包不给通用 skills。
- SAT Mining 使用专用 mining runtime 和 mining wallet policy。
- 安装 skill、审查插件或允许 Agent 使用 skill 都不会自动授予钱包访问。

对 wallet-capable skills，请在 **Wallets > Skill Grants** 中授予最窄的 actions、wallet ids、chains、caps 和 automation level。

新 signer wallet 使用 versioned role-ready baseline，而不是 unlimited default。
Legacy deny-all wallet 需要一次明确 review 后 activation。创建 Agent wallet 不会
自动设为 Default Agent；risky routing 顺序是 explicit wallet、skill grant、Agent
assignment、最后才是 optional Default Agent fallback。Mining retirement 在移动
runtime assignment 前写入永久 signer tombstone。

## 发布前检查

- 非 loopback 访问启用 Gateway auth。
- 远程访问使用 Tailscale、SSH tunnel 或锁定的反向代理。
- Models、Channels、Services、Skills、Tools、Memory、Tasks 按 Agent 配置。
- Skills 安装前审查；依赖安装后验证。
- Wallet Skill Grants 与 Mining/Vault 角色分离。
- 安装 smoke test 后检查 Logs 和 Usage。
- Advanced > Debug 和 Advanced > Nodes 只作为运维诊断，不作为首次设置入口。
