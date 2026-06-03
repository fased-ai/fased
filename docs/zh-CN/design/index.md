---
summary: "Control UI 设计系统：导航、卡片、标签页、弹窗、widgets、表单和运维页面。"
read_when:
  - 修改 Control UI 布局、主题、Dashboard、卡片、弹窗或导航
  - 判断新页面应属于 Agent、Dashboard 还是 Advanced
title: "Control UI 设计"
---

# Control UI 设计

这是 Fased 浏览器 Control UI 的设计准则。新增页面或重构 UI 时，优先遵循这里的规则，而不是为单个页面创建一次性样式。

## 产品模型

Control UI 是围绕一个选定 Agent 的工作台，加少量全局运维页面：

- **Dashboard**：紧凑概览小组件板。
- **Chat**：选定 Agent/session 的浏览器聊天界面。
- **Agents**：普通设置入口，包含 Models、Channels、Skills、Tools、Memory、Services、Tasks、Sessions、Files、Coordination。
- **Wallets**、**Mining**、**Fased Network**、**Marketplace**、**Extensions**、**Notifications**、**Usage**：一等全局操作页面。
- **Advanced**：Config、Debug、Nodes。不要把 Debug 或 Nodes 放回主导航。

旧的全局 Providers、Channels、Services、Tasks、Skills、Memory、Debug、Nodes 页面可以保留为深链或管理员视图，但主导航应保持简单。

## 主题

- 每个主题使用一个主背景色，靠边框、间距和排版区分层级。
- 暗色主题是黑/石墨色，主要 action 使用白底黑字。
- 亮色主题是白/中性色，主要 action 使用黑底白字。
- 不使用装饰性渐变、浮动光球或大面积彩色背景。
- 颜色只用于状态：绿色 ready，琥珀 warning，红色 error，蓝色仅用于真正的信息状态。

## 布局

- 左侧导航可折叠：收起时只显示图标，展开时显示图标和文字。
- 顶部栏显示当前页面标题、health dot、Docs 图标、主题/账号/退出菜单。
- Dashboard 的 `+ Widget` 和 refresh 放在顶部栏。
- Chat 的会话/模型/统计控制放在顶部栏，不再额外占用页面顶部空间。
- 页面正文不要重复顶部栏已经显示的页面标题。

## 卡片

- 卡片是扁平控制面：边框、中性背景、小圆角、紧凑 padding。
- 不要把整页包进一个大卡片，再在里面塞卡片。
- 不要嵌套卡片；需要分组时使用分隔线、行或紧凑 metric block。
- 摘要卡片使用大数字/头像/图标/状态 + 短标签 + 一两个动作。
- 说明文字放到 helper 图标里，不要堆在卡片正文。

## Dashboard widgets

Dashboard 是概览，不是启动链接目录。默认 widgets：

- Agents：Agents、tasks、sessions。
- Usage：所选时间窗口内的 token usage history。
- Wallets：按 Agent、Mining、Vault 角色聚合的钱包和 SOL。
- Mining：mining 状态、mining 钱包余额、capital、7 天 history。
- Fased Network：hosted 状态和地址/handle 摘要。

Widget 规则：

- 通过 header 拖动。
- 内容不能产生横向滚动；换行或截断。
- 内容过多时只在 widget 内部纵向滚动。
- Gateway Access 和 Runtime Clients 不属于普通 Dashboard；需要时去 Advanced > Debug/Nodes。

## Tabs、modals 和 helper

- Tabs 使用紧凑 segmented control，选中状态在亮/暗主题都必须可读。
- 创建、编辑、审查、安装、授权、危险确认都使用真正的 modal。
- Modal 居中，限制在 viewport 内；body 可纵向滚动；失败时不要静默关闭。
- 点击 backdrop 可关闭普通 modal。
- Helper 使用 lucide question/help 图标，不要套装饰气泡；文案使用正常句式，不要全大写。

## 所有权规则

- Models：Agent > Models。
- 渠道账号和路由：Agent > Channels。
- 服务凭证：Agent > Services 或对应服务页。
- 工具权限：Agent > Tools。
- Skills：Agent > Skills。
- Skill 钱包授权：Wallets > Access / Skill Grants。
- 插件 runtime 生命周期：Extensions。
- Hook packs：Extensions > Hooks。
- 原始配置、Debug、Nodes：Advanced。

## 安全 UI

敏感能力必须分离：

- 安装 skill 只写文件或依赖。
- Allow skill 只把 skill 附加给 Agent。
- Grant tools/wallets 才给运行时权限。
- Mining/Vault 钱包不提供给通用 skills。
- 外部 npm/go/uv/brew/download 安装器必须显示来源、命令、pin/integrity 和 PATH 验证结果。

## 测试要求

涉及共享布局或真实工作流的 UI 改动应有浏览器测试：

- 导航/topbar/sidebar：路由和响应式。
- Modal：按钮打开、backdrop 关闭、成功/错误可见。
- Dashboard：add/remove/move widget，且无内容横向 overflow。
- Agent tabs：保持选定 Agent 作用域。
- Skills：create/edit、review install、dependency install、Agent allow toggle。
- Wallet/mining：review gate 和 policy 不被放宽。
