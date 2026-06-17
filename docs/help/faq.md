---
summary: "Compact FAQ for Fased setup, models, channels, wallets, tasks, and troubleshooting."
read_when:
  - Answering common setup, install, onboarding, or support questions
  - Triaging user-reported issues before deeper debugging
title: "FAQ"
---

# FAQ

Use this page for quick answers. If something is actively broken, start with
[Troubleshooting](/help/troubleshooting), [Diagnostics](/diagnostics/index),
and [Gateway Troubleshooting](/gateway/troubleshooting).

## First 60 Seconds If Something's Broken

<a id="first-60-seconds-if-somethings-broken"></a>

Run this first:

```bash
fased status
fased status --all
fased gateway probe
fased gateway status
fased doctor
fased logs --follow
```

Then open the owner page for the thing that failed:

- Agent > Models for model/provider issues.
- Agent > Channels for chat routes.
- Agent > Services for external APIs.
- Agent > Skills and Agent > Tools for capability issues.
- Agent > Memory for memory/QMD/session-memory state.
- Agent > Tasks for saved task definitions and runs.
- Wallets, Mining, or Fased Network for crypto/operator state.

## I'm Stuck - What's The Fastest Way To Get Unstuck?

<a id="im-stuck--whats-the-fastest-way-to-get-unstuck"></a>

1. Run `fased status --all`.
2. Open **Logs** and filter for the failing subsystem.
3. Check the focused owner page instead of raw config.
4. Run `fased doctor`.
5. If it is a channel issue, run `fased channels status --probe`.

For wallet/mining/network issues:

```bash
fased wallet status --json
fased wallet signer doctor --json
fased mining readiness --wallet mining
fased mining status --json
fased federation status --json
```

## Install And First Run

### What's the recommended way to install and set up Fased?

Use [Getting Started](/start/getting-started). The normal path is:

1. Install.
2. Run onboarding.
3. Open the Control UI.
4. Configure a model provider.
5. Send a first chat.
6. Add channels, skills, tasks, wallets, mining, or Fased Network only when you
   need them.

### What does onboarding do?

Onboarding creates the local baseline: state directory, config,
workspace, Gateway, dashboard access, and optional initial wallet/mining setup.

It does not fully configure every model, channel, skill, task, service, wallet,
or network role. Those belong in the Control UI after the base install works.

See [Onboarding Overview](/start/wizard) and
[Control UI Setup](/start/control-ui-setup).

### How do I open the dashboard?

Use:

```bash
fased dashboard
```

Or check:

```bash
fased gateway status
```

### How long does install and onboarding take?

Local install is usually minutes. Real channel, provider, wallet, device, or
remote setup can take longer because each external service has its own account,
token, permission, and network requirements.

### Installer stuck? How do I get more feedback?

<a id="installer-stuck-how-do-i-get-more-feedback"></a>

Run:

```bash
fased status
fased doctor
fased logs --follow
```

If this is a source checkout, use the Install docs for your platform:

- [Install](/install/index)
- [Docker](/install/docker)
- [Podman](/install/podman)
- [Nix](/install/nix)
- [macOS App](/start/onboarding)

## Models And Providers

### Do I need a model subscription or API key?

You need at least one usable model path. That can be an API key, OAuth profile,
subscription-backed CLI path where supported, or a local model endpoint.

Configure it in **Agent > Models**. Use [Models](/concepts/models) and
[Model Providers](/concepts/model-providers) for details.

### What model do you recommend?

Use the strongest reliable model available for the Agent's job. Tool-enabled
Agents that read untrusted content should use stronger instruction-following
models and tighter tool controls. Smaller/local models can be useful, but reduce
tool authority and sandbox aggressively.

### How do I switch models?

Use **Agent > Models** or chat model commands where enabled. Avoid editing raw
config unless the UI does not expose the option you need.

### Why do I see "All models failed"?

Usually one of these:

- no credential for the selected provider/profile;
- model ref is not allowed by the provider config;
- provider quota/account issue;
- network/API failure;
- fallback model also lacks credentials.

Start with **Agent > Models**, then check [Model Failover](/concepts/model-failover).

## Channels And Replies

### Fased does not reply. What should I check?

Run:

```bash
fased gateway status
fased channels status --probe
fased pairing list --channel <channel>
fased logs --follow
```

Common causes:

- sender not paired or allowlisted;
- group requires a mention;
- channel token/account is not ready;
- selected Agent route is wrong;
- Gateway auth/URL mismatch.

See [Channels Troubleshooting](/channels/troubleshooting).

### Do groups and DMs share context?

Groups are isolated by channel/group/thread. DMs default to the main Agent
session for continuity, but multi-user setups should use:

```json5
{
  session: { dmScope: "per-channel-peer" },
}
```

See [Session Management](/concepts/session).

## Tasks And Automation

### Can Fased run tasks on a schedule?

Yes. Tasks are saved definitions owned by an Agent/session. Runs are history.
Use **Agent > Tasks** or:

```bash
fased task list
fased task run <task-id>
```

See [Tasks](/concepts/agents-sessions-tasks) and
[Scheduled Tasks](/automation/cron-jobs).

### Tasks or reminders do not fire. What should I check?

Check:

- Agent > Tasks shows the saved Task.
- The Task is not paused.
- Gateway/worker is running.
- Model/skill/service preflight passes.
- Delivery target still exists.
- Logs show no stale lease or queue error.

Use [Troubleshooting](/help/troubleshooting) for the command ladder.

### How do I stop a running task?

Use Agent > Tasks run controls, `/task cancel-run <run-id>`, or:

```bash
fased task runs --id <task-id>
fased task cancel-run <run-id>
```

## Wallets, Mining, And Fased Network

### Which docs should I read?

- [Wallet page](/plugins/crypto/wallet-page)
- [Wallet roles and policies](/plugins/crypto/wallet-roles-and-policies)
- [Mining page](/plugins/crypto/mining-page)
- [Mining troubleshooting](/plugins/crypto/mining-troubleshooting)
- [Fased Network](/start/federation)
- [Bond operator](/start/bond-operator-economy)

### How should I split wallets?

Use separate roles where possible:

- Agent wallet for normal Agent wallet actions.
- Mining wallet for SAT mining.
- Vault wallet for bond and operator funds.

This makes wallet roles, screenshots, and recovery easier to reason about.

### What do I need before SAT mining?

You need:

- a configured mining wallet;
- signer reachable;
- RPC reachable;
- SOL wallet balance for fees;
- funded miner capital;
- readiness checks passing.

Mining outcomes vary by cycle, commit, strategy, rebates, fees, and mining
state. Use small first runs until readiness and recovery are understood.

### Why can a submitted commit be lower than my target?

Fased caps actual commit by usable miner capital, locked/pending capital,
fee reserve, erosion coverage, and recovery buffer. A lower submit can be
correct when capital is clearing or fee headroom changes.

### Does Fased Network require a bond?

Some public/operator flows may use bond state as an eligibility or trust signal.
The Wallet, Agent, and local Fased install do not require a bond for normal use.

## Memory, Files, And Backup

### Where does Fased store its data?

<a id="where-does-fased-store-its-data"></a>

Default state lives under `~/.fased`.

Common paths:

- `~/.fased/fased.json`
- `~/.fased/credentials/`
- `~/.fased/agents/<agentId>/sessions/`
- `~/.fased/workspace`
- `~/.fased/extensions/`
- `~/.fased/sandboxes/`

See [Agent Workspace](/concepts/agent-workspace) and
[Gateway Configuration](/gateway/configuration).

### What's the recommended backup strategy?

<a id="whats-the-recommended-backup-strategy"></a>

Back up the Agent workspace privately. Keep `~/.fased/credentials`,
auth profiles, secrets, and sessions out of public repos. If you migrate to a
new machine, copy state deliberately and verify paths with `fased status`.

See [Migration Guide](/install/migrating).

### Does memory persist forever?

Workspace memory files persist until changed or deleted. Session transcripts
and session metadata are controlled by session maintenance settings. See
[Memory](/concepts/memory) and [Session Management](/concepts/session).

## Config And Environment

### Env Vars And .env Loading

<a id="env-vars-and-env-loading"></a>

See [Environment Variables](/help/environment).

### How does Fased load environment variables?

<a id="how-does-fased-load-environment-variables"></a>

Precedence is:

1. process environment;
2. `.env` in current working directory;
3. `~/.fased/.env`;
4. config `env` block;
5. optional login-shell import.

Fased does not override existing values. See
[Environment Variables](/help/environment).

### What format is config?

`~/.fased/fased.json` uses JSON5. Prefer the Control UI for normal setup. Use
raw config when a field has no focused UI yet.

### Do I have to restart after changing config?

Some fields hot-apply; others require restart. If behavior looks stale, restart
the Gateway and re-run `fased status`.

## Remote Gateway And Nodes

### Should I run Gateway locally or remotely?

Local is easiest for first setup. Remote/VPS is useful when you need always-on
availability. Keep raw Gateway access private and use Tailscale/SSH or a trusted
proxy.

See [Remote Gateway](/gateway/remote).

### Do nodes run a Gateway service?

Nodes are paired execution/device surfaces. The Gateway remains the control
plane. Treat node pairing as operator-level access to that node's capabilities.

## Security

### Should I expose Fased to inbound DMs?

Use pairing or allowlists. Avoid open inbound DMs for tool-enabled Agents unless
you intentionally trust that audience and have tight tool controls.

### Is prompt injection only a concern for public channels?

No. Prompt injection can arrive through web pages, emails, files, logs, images,
or pasted text. Use access control, tool controls, sandboxing, and modern models;
do not rely on prompt wording alone.

See [Gateway security](/gateway/security).

### Should my agent have separate accounts?

For channels, email, browser profiles, wallets, and paired devices, separate
accounts make permission and recovery cleaner. Keep personal accounts out of a
Fased install you expose to other users.

## More Help

- [Help hub](/help/index)
- [Troubleshooting](/help/troubleshooting)
- [Diagnostics](/diagnostics/index)
- [Gateway Troubleshooting](/gateway/troubleshooting)
- [Testing](/help/testing)
