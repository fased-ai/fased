# Fased

Fased is a self-hosted agent runtime for local-first control, Agent-scoped setup,
wallet-safe automation, SAT mining, Fased Network participation, and
marketplace/operator workflows from one gateway.

The runtime brings models, channels, tools, skills, services, wallets, mining,
network presence, tasks, and workflow activity into one browser workbench that
the operator controls.

Links:

- Website: [fased.ai](https://fased.ai)
- Docs: [docs.fased.ai](https://docs.fased.ai)
- Repository: [fased-ai/fased](https://github.com/fased-ai/fased)

## What Fased Runs

The public codebase includes:

- Gateway, CLI, onboarding, local auth, device pairing, and browser Control UI
- Agent workbench for Models, Channels, Services, Skills, Tools, Memory,
  Sessions, Files, Tasks, Coordination, and Programs
- Task ledger and workflow layer for scheduled work, webhooks, channel work,
  media jobs, wallet approvals, marketplace actions, mining events, ACP/subagent
  runs, and CLI/system activity
- Wallet UI, local signer integration, role-separated wallet policy, approval
  diff/simulation, and spend caps
- SAT mining page/runtime path, mining wallet separation, capital state, cycle
  history, and mining event ledger records
- Fased Network, node presence, operator/bond surfaces, and marketplace offers
- Skill Library and ClawHub review/install flow with per-Agent skill access
- Services for web/search, GitHub, Google Workspace, browser/media, and
  plugin-reported connectors
- Extensions, plugin SDK, paired nodes, mobile/macOS app code, and public docs

## Product Model

Fased is Agent-first. Most normal setup starts from **Agents**:

- **Setup** summarizes the selected Agent.
- **Models** connects provider accounts and assigns primary, fallback, and task
  model roles.
- **Channels** connects message surfaces and routes them to the Agent.
- **Services** connects credentials and API surfaces.
- **Skills** installs, edits, configures, and allows skills per Agent.
- **Tools** grants or blocks runtime tools per Agent.
- **Tasks** defines scheduled tasks, webhook triggers, workflows, graph
  workflows, templates, and Programs, then shows one correlated activity ledger.
- **Sessions** manages conversation and task contexts.
- **Memory** manages archive/QMD state and diagnostics for the Agent.
- **Files** shows the Agent workspace without exposing arbitrary host paths.

Domain pages keep authority. **Wallets**, **Mining**, **Marketplace**,
**Channels**, and **Services** own the actions that can spend, broadcast, mine,
deliver, or change external state. **Agent > Tasks** is the audit/work surface
that links those events together.

## Current Status

Ready in this repo:

- repo-backed install and onboarding
- local dashboard auth and localhost auto-open flow
- browser Control UI with Agent-first setup
- provider/model setup including OpenAI, Anthropic, Google, OpenRouter, xAI,
  Ollama, LM Studio, and Custom/vLLM-compatible local endpoints
- channel setup grouped by major, enterprise, self-hosted/protocol, and plugin
  channels
- per-Agent tools/skills/services access
- task ledger, webhook triggers, workflows, graph editor, templates, Programs,
  source-specific actions, and activity correlation
- wallet policy, local signer flow, caps, approval review, and role-separated
  wallet surfaces
- SAT mining UI/runtime path and mining event records
- Fased Network, marketplace, usage ledger, notifications, logs, debug, nodes,
  and Advanced operator surfaces

Still guarded or intentionally staged:

- trading and market/news workflows remain behind explicit plugin/risk gates
- richer visual workflow polish can continue on top of the existing graph JSON
  runtime
- public package distribution can come after the repo install path remains
  consistently stable

## Install

Public install is repo-backed:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh
fased dashboard
```

`install.sh` runs onboarding by default. Use `./install.sh --no-onboard` only
when you want to install first and run onboarding later:

```bash
fased onboard --install-daemon
```

Recommended first run:

1. Open the dashboard with `fased dashboard`.
2. Select or create an Agent.
3. Configure **Agent > Models**.
4. Send a browser chat in **Chat**.
5. Add channels, skills, services, wallets, mining, and tasks only as needed.

Read next:

- [Getting Started](https://docs.fased.ai/start/getting-started)
- [Install](https://docs.fased.ai/install)
- [Onboarding Wizard](https://docs.fased.ai/start/wizard)
- [Control UI](https://docs.fased.ai/web/control-ui)
- [Dashboard](https://docs.fased.ai/web/dashboard)

## Security Defaults

Fased is built around private access and explicit authority boundaries:

- Local dashboard links use a gateway token flow; local browser opens can be
  auth-ready without repeatedly pasting tokens.
- Remote access should stay private through Tailscale or another private
  network. Public internet exposure belongs behind a deliberate hardened
  deployment plan.
- New remote browser/device access requires pairing approval.
- Skills require explicit wallet, mining, service, or tool grants.
- Services connect credentials; Agent Tools and Skills decide what a selected
  Agent may use.
- Wallet pages own signing, caps, approval, and broadcast. Workflows can request
  or review wallet actions while spend authority stays in wallet policy.
- Marketplace and Mining pages own their state-changing controls. Agent Tasks
  records and reviews those actions.
- Advanced/Debug/Nodes are operator/admin surfaces for diagnostics and raw
  controls.

Read:

- [Security](https://docs.fased.ai/security)
- [Gateway Security](https://docs.fased.ai/gateway/security)
- [Wallet Page](https://docs.fased.ai/plugins/crypto/wallet-page)
- [Mining Page](https://docs.fased.ai/plugins/crypto/mining-page)

## Tasks And Workflows

Fased uses a ledger-backed workflow layer with constrained node types and shared
Agent activity records.

- **Task**: a saved scheduled definition for an Agent.
- **Trigger**: an HTTP/webhook entrypoint that can run an Agent prompt,
  heartbeat wake, or workflow target.
- **Workflow**: a saved multi-step procedure.
- **Graph**: a visual editor for the same workflow JSON/runtime.
- **Template**: a starter workflow such as wallet approval review, mining
  readiness/start gate, marketplace delivery/dispute, channel delivery review,
  media generation review, or service health check.
- **Program**: an Agent-scoped durable standing order that can propose work for
  review while grants still come from Tools, Skills, Wallets, and Mining policy.
- **Activity**: the ledger of what actually happened, grouped by correlation id.

This solves the old scattered-work problem: cron runs, webhooks, channel tasks,
media work, wallet approvals, marketplace records, mining events, ACP/subagents,
and CLI/system runs can be inspected from one Agent work surface while the
domain page still controls the risky action.

Read:

- [Automation](https://docs.fased.ai/automation)
- [Control UI Tasks](https://docs.fased.ai/web/control-ui)

## Wallets, Mining, And Marketplace

Wallets are role-separated:

- **Agent** wallets are for ordinary agent operations.
- **Mining** wallets are for SAT mining capital and mining actions.
- **Vault** wallets are for reserve/bond/operator roles.

Fased favors a self-hosted local signer and explicit policy over hosted wallet
abstraction. External wallet providers can make sense for managed custody,
multi-tenant products, or compliance-heavy deployments, but Fased's default
model keeps keys and approvals under the operator's runtime and policy.

Marketplace and Mining integration is intentionally task-ledger aware:

- Wallet approvals show spend/policy evidence.
- Mining events mirror readiness, start/stop, cycle, claim, recovery, and
  capital changes.
- Marketplace offer/order/delivery/dispute records can be reviewed from the
  activity stream while Marketplace remains the authority page.

## Docs By Goal

- First install: [Start](https://docs.fased.ai/start/getting-started)
- Local vs hosted: [Install](https://docs.fased.ai/install)
- Remote/private access: [Gateway](https://docs.fased.ai/gateway)
- Models: [Providers](https://docs.fased.ai/providers)
- Chat apps: [Channels](https://docs.fased.ai/channels)
- Skills and dependencies: [Tools](https://docs.fased.ai/tools)
- Wallets and mining: [Crypto Plugins](https://docs.fased.ai/plugins/crypto)
- Agent workbench: [Agents](https://docs.fased.ai/agents)
- Dashboard and browser UI: [Web](https://docs.fased.ai/web)
- Logs, usage, debug, nodes: [Diagnostics](https://docs.fased.ai/diagnostics)
- Security model: [Security](https://docs.fased.ai/security)
- Concepts and mental model: [Concepts](https://docs.fased.ai/concepts)

## Development

Common source commands:

```bash
pnpm install
pnpm build
pnpm test:fast
pnpm --dir ui test
pnpm ui:build
pnpm check:docs
```

Run locally:

```bash
pnpm dev
# or
pnpm fased gateway
```

Useful docs:

- [Contributing](./CONTRIBUTING.md)
- [Releasing](./RELEASING.md)
- [Security](./SECURITY.md)
- [Plugin license policy](./PLUGIN_LICENSE_POLICY.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## Root Layout

The root intentionally contains both product code and build/deploy control files:

- `src/`: gateway, CLI, providers, agents, tasks, wallet, mining, marketplace,
  plugin/runtime, and server logic
- `ui/`: browser Control UI
- `docs/`: public docs site
- `apps/`: macOS, iOS, Android, and shared app surfaces
- `extensions/`: bundled extensions and extension runtime code
- `skills/`: bundled skills and skill metadata
- `packages/`: shared packages and plugin SDK outputs
- `scripts/`: build, install, docs, release, and test scripts
- `tools/`: repo tooling and operator helpers
- `vendor/`: vendored third-party code that must keep its own notices
- `config/`: runtime and channel/provider configuration helpers
- `test/`: test fixtures and integration helpers
- `token/`: SAT/token technical materials
- `Dockerfile*`, `docker-compose.yml`, `podman`, `fly`, and `render` files:
  supported deployment/build entrypoints

Root config files should stay at repository root unless the owning toolchain,
docs publisher, installer, and CI path are updated together.

## Legal, Attribution, And Risk

Fased is published under MIT with required third-party and copied-code notices.

Important:

- MIT permits modification and redistribution, but existing copyright and
  permission notices for copied material must be preserved.
- Third-party bundled code and assets are tracked in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

Before using wallet, mining, federation, trading, marketplace, or similar
operator features, read:

- [LICENSE](./LICENSE)
- [SECURITY.md](./SECURITY.md)
- [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- [DISCLAIMER.md](./DISCLAIMER.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [PLUGIN_LICENSE_POLICY.md](./PLUGIN_LICENSE_POLICY.md)

Fased software is not financial, investment, tax, legal, or operational advice.
Wallets, crypto, mining, federation, trading, marketplace, and news/market
workflows carry real risk.

## Roadmap

Near-term work:

- keep hardening task ledger and workflow UX
- expand Agent Programs and controlled standing-order review
- improve workflow graph polish on top of the shared ledger-backed runtime
- harden SAT mining, marketplace, federation, and operator evidence flows
- keep local provider, channel, skill, service, and wallet setup beginner-clear
- keep release gates, docs screenshots, and optional package publication aligned
  with the repo install path

Roadmap docs:

- [Roadmap](https://docs.fased.ai/reference/roadmap)
