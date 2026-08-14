---
title: "Full Release Validation"
summary: "使用仓库内脚本和 smoke lanes 的公开发布检查表"
read_when:
  - 准备 Fased 公开发布
  - 验证 docs、install flows、Control UI、Agent flow、Docker 或 live-provider lanes
  - 判断 push release branch 前哪些检查必需、哪些可选
---

# Full Release Validation

本页是围绕本仓库实际存在脚本的 release checklist。它不定义新的产品行为。

公开发布分支 push 前运行 required checks。可选 lanes 只在该 subsystem 被修改，或 release hardware/secrets 可用时运行。

## Required local gate

从 Fased 仓库根目录开始：

```bash
pnpm check
pnpm build
pnpm ui:build
pnpm test:fast
pnpm test:ui
pnpm test:smoke:agent-flow
pnpm check:docs
```

覆盖范围：

| Command                      | Coverage                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm check`                 | format、lint、docs temp guards、auth/channel boundary guards、Swift env-policy generation check。 |
| `pnpm build`                 | TypeScript bundle、plugin SDK d.ts、protocol/build metadata、canvas/export template copies。      |
| `pnpm ui:build`              | Control UI production build。                                                                     |
| `pnpm test:fast`             | `vitest.unit.config.ts` unit suite。                                                              |
| `pnpm test:ui`               | Control UI test suite 和 raw-window-open guard。                                                  |
| `pnpm test:smoke:agent-flow` | Provider -> Agent -> Skill -> Chat -> Task -> Memory -> Channel delivery composite smoke lane。   |
| `pnpm check:docs`            | docs formatting、markdown lint、internal link audit。                                             |

默认 Gateway port 被本地开发占用时：

```bash
pnpm test:force
```

## Gateway and runtime smoke

Gateway routing、websocket/http、node pairing、sessions 或 operator pages 变化时运行：

```bash
pnpm test:e2e
```

可用 focused lanes：

```bash
pnpm test:loopback
pnpm test:browser-cdp
```

`test:browser-cdp` 需要 loopback/CDP-capable environment。

## Docker smoke

Docker checks 较慢，要求 Docker/Podman-compatible host。onboarding、plugin、gateway-network、cleanup 变化时使用。

```bash
pnpm test:docker:onboard
pnpm test:docker:qr
pnpm test:docker:plugins
pnpm test:docker:gateway-network
```

完整 container lane：

```bash
pnpm test:docker:all
```

Provider-specific install E2E 只在 release secrets 可用时运行。

## Live provider checks

Live checks 需要凭据，不应该在普通本地开发中运行：

```bash
FASED_LIVE_TEST=1 pnpm test:live
```

把 live failure 当作 code regression 前，先区分 provider outage、quota/rate limit、坏 secrets、model catalog 变化、runner 网络/DNS、以及真实 runtime regression。

## Docs release gate

Docs-only release work：

```bash
pnpm format:docs:check
pnpm lint:docs
pnpm docs:check-links
```

公开 launch docs 最终前手动检查：

- install paths：local、Docker/Podman、VPS、Tailscale
- Agent-first setup：Models、Channels、Skills、Tools、Memory、Tasks、Services
- wallet funding 和 Wallet > Skill Grants
- SAT mining start/stop/readiness
- Dashboard、Usage、Logs、Advanced > Debug/Nodes
- beginner-critical screenshots

## Manual product smoke

用新的临时 Agent 验证：

1. Onboarding 生成或复用 gateway token，并打开 auth-ready Control UI URL。
2. Agent > Models 完成 sign-in 或 provider key，保存 primary/fallback model refs。
3. Chat 返回一次 model-backed reply，Usage 记录 provider/model tokens。
4. Agent > Skills 创建本地 skill，为 Agent 启用，并在 Chat 中看到 skill loaded。
5. Agent > Memory 启用 session archive，`/new` 或 `/reset` 在有内容时写 archive。
6. Agent > Channels 将测试频道账号路由到选定 Agent。
7. Agent > Tasks 创建继承 Agent model/skills policy 的 scheduled task。
8. Wallet page 显示 role separation，Wallet > Skill Grants 不向 generic skills 授予 mining/vault roles。
9. Mining page 可只读 status；start/stop 仅通过 configured mining wallet 和 approvals。
10. Advanced > Debug 保持 operator-only，不复制普通 setup flows。
