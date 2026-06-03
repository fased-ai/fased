---
name: sat-mining
description: SAT mining scaffold for allocation analysis, round participation, and wallet-backed mining orchestration.
summary: SAT mining scaffold for allocation analysis, round participation, and wallet-backed mining orchestration.
---

# SAT Mining

This bundled skill gives the agent operator-facing guidance for the SAT mining
runtime. The actual mining runtime is provided by the `sat-mining` bundled
plugin and only runs when the plugin config enables it.

Responsibilities:

- watch SAT rounds and epoch timing
- analyze the 25-bucket allocation payoff surface
- prepare wallet-backed allocation plans
- submit heartbeat, commit, and reveal actions
- coordinate with federation peers when swarm mode is enabled

Runtime boundary:

- when `sat-mining.enabled=false`, the plugin still exposes read/status tools
  but does not run mining automation
- natural-language `@mining` control from chat or channels must use the core
  `mining` tool, because that is the same gateway path the Mining UI uses
- for user requests to show mining status, readiness, wallet attachment,
  history, or recovery, use read-only `mining` actions; do not use round audit
  tools unless the user provides the epoch, micro-round, and validator context
- if the user says not to start mining, do not call mutating mining actions such
  as start, participate, commit, reveal, claim, dispute, or strategy updates
- `sat_status` is optional, read-only diagnostics only; never use it to report
  that mining started, stopped, changed wallet, or changed strategy
- wallet-backed submit/claim/dispute actions require the configured wallet
  runtime policy and execution approval gates
- skill-mode planning is optional and falls back to deterministic/base strategy
  when configured to do so
