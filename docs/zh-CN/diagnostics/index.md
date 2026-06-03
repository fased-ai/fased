---
title: "诊断"
summary: "Logs、Usage、Advanced > Debug、Advanced > Nodes 和诊断 flags 的运维地图。"
read_when:
  - 排查正在运行的 Fased Gateway
  - 判断应该打开 Logs、Usage、Advanced > Debug 还是 Advanced > Nodes
---

# 诊断

诊断页面是 operator/admin surfaces。它们解释 Gateway 正在做什么，不是连接模型、渠道、服务、Skills、Memory 或 Tasks 的第一入口。

普通设置从选定 Agent 开始：

- **Agent > Models**：模型引用和角色。
- **Agent > Channels**：聊天账号和路由。
- **Agent > Skills**：skill 安装、编辑、配置和每 Agent access。
- **Agent > Tools**：每 Agent 工具 allow/deny。
- **Agent > Services**：web/search、Gmail、GitHub、browser/media 等 API。
- **Agent > Memory**：session-memory 和 QMD 状态。

## 页面地图

| 页面      | UI 位置               | 用途                                                                                                              |
| --------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Logs      | **Logs**              | Gateway 文件日志、过滤、auto-follow、export。                                                                     |
| Usage     | **Usage**             | 按 Agent、provider、model、session、task、channel/source、tokens 和 cost 查看 7 天本地 usage history。            |
| Debug     | **Advanced > Debug**  | 有序状态卡、status/health/model 快照、插件 runtime、provider catalog、memory repair preview、event log、raw RPC。 |
| Nodes     | **Advanced > Nodes**  | 已配对设备、pending pairing、命令暴露、capabilities、permissions、last-seen。                                     |
| Config    | **Advanced > Config** | 原始 `~/.fased/fased.json` escape hatch。                                                                         |
| Dashboard | **Dashboard**         | 紧凑 health widgets；不替代 Logs、Usage 或 Advanced。                                                             |

## 首先检查

1. 看顶部 health dot。
2. 打开 **Logs**，按失败子系统过滤。
3. 打开拥有该设置的焦点页面，例如 **Agent > Services** 或 **Agent > Channels**。
4. 只有需要原始状态、插件 runtime 或 Memory Doctor repair preview 时才打开 **Advanced > Debug**。
5. 涉及设备配对或节点能力时打开 **Advanced > Nodes**。

## Usage vs Quota

**Usage** 是 Fased 本地记录的模型调用历史。它优先使用 transcript 和 task run-log usage records。Provider 账号 quota/status 是另一类数据，不等同于本地 usage history。

## Diagnostic flags

Diagnostic flags 是定向日志开关。普通 Logs 不够时再开启，不要把全局 logging 调到 trace。

- 在 **Advanced > Config** 的 `diagnostics.flags` 配置，或用 `FASED_DIAGNOSTICS` 做一次性覆盖。
- 复现问题。
- 在 **Logs** 或 `fased logs --follow` 中读取输出。

参见 [Diagnostics Flags](/diagnostics/flags)。
