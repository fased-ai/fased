---
summary: "当前 wallet、Fased Network、SAT 和 operator trust tranche 之后的 Fased roadmap。"
read_when:
  - 你想了解下一步产品方向
  - 你需要当前 Fased roadmap summary
title: "Roadmap"
---

# Roadmap

此 roadmap 反映当前 Fased 方向，不是早期 product shape。

## 当前完成 tranche

当前 tranche 围绕：

- wallet selection 和 signer posture
- SAT mining
- Fased Network bond 和 bonded operator flows
- operator trust read-only status UI
- local offers 和 marketplace offer discovery

## 下一步实现 lanes

### 1. Bonded verified chat

围绕以下能力构建 self-hosted communication：

- verified DM
- public inbox
- bonded room host
- append-only signed room logs
- optional bonded room mirrors

方向：

- off-chain messaging
- local storage per node
- signed message envelopes
- HTTP / WebSocket sync
- end-to-end encryption

### 2. Marketplace and operator maturity

- strengthen public offer execution flows
- mature operator evidence into live collection/payment only when approved
- keep bond as trust and anti-spam policy, not message gas

### 3. Reviewed wallet actions

作为 wallet policy 之上的独立高风险 surface，而不是 runtime 的默认隐式行为。

### 4. News / market-intelligence engine

作为独立 operator 或 plugin lane：

- news ingestion
- market summaries
- signal review
- research workflows

必须清楚与 financial advice claims 分离。

### 5. Public release packaging

- clean public docs and legal surface
- public repo release flow
- 只有 release/update path 稳定后才发布 `fased` npm package

## Design principle

Fased 应继续把 SAT 和 bond 用于：

- trust
- operator eligibility
- spam resistance
- directory identity

避免把所有 higher-level product actions 都变成 on-chain message gas。
