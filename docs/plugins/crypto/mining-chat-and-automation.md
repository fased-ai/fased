---
summary: "Operate Satcoin mining from chat, channels, and scheduled tasks with @mining."
read_when:
  - You want to start, stop, fund, or inspect Satcoin mining from chat
  - You want scheduled or conditional mining automation
  - You need the full @mining action map
title: "Mining Chat and Automation"
---

# Mining Chat and Automation

`@mining` is the chat handle for Satcoin mining operations. It uses the
dedicated mining tool.

That boundary matters:

- the Mining wallet can run Satcoin mining operations
- the Mining wallet can claim and optionally sweep SAT after mining
- Agent wallets handle ordinary sends, Marketplace order actions, optional route
  actions, and scheduled wallet actions
- Vault wallets handle protected storage and Fased Network bond authority

When task logs say a strategy task used "no wallet source", that does not mean
mining ran without the Mining wallet. It means the isolated task did not load
the generic wallet tool/source. The task only read `@mining` state and used the
mining tool. Fased mining still uses the configured Mining wallet for real
cycle submit, claim, sweep, and capital actions under the normal Mining wallet
controls.

## What chat can do

Chat and paired channels can call the same mining actions as the Mining page.
Use the exact mining wallet handle when starting with a wallet:

```text
Check @mining readiness.
Start @mining with @wallet:mining.
Stop @mining.
Set @mining commit to 0.75 SOL.
Show @mining history for the last 24 hours.
Ask @mining to analyze strategy from my recent history.
```

Start and stop commands are status-verified. The agent must not say mining
started just because the request was sent. It reports success only after
`sat.startMining` returns a status with mining running. Likewise, stop reports a
hard stop only when the returned status is no longer running; if locked capital
or pending cycles remain, it reports drain/recovery mode.

Do not use the low-level `sat_status` diagnostic tool for chat control. It is
read-only diagnostics and cannot start, stop, reassign the mining wallet, or change
strategy.

## CLI parity

The terminal surface uses the same Gateway methods as chat and the Mining page.
The documented CLI command is the installed `fased` binary. If `fased` is
missing, rerun `./install.sh --no-onboard` from the repo checkout before
testing CLI parity.

```bash
fased mining status
fased mining readiness --wallet mining
fased mining wallets
fased mining start --wallet mining
fased mining stop
fased mining history --window 24h
fased mining deposit-capital --sol 0.01
fased mining withdraw-capital --sol 0.01
fased mining set-commit --sol 0.01
```

For scripted checks, add `--json` to inspect the raw Gateway payload. CLI
start/stop also wait for the final Gateway result and validate status before
printing success.

## Action map

The mining tool supports these lanes.

**Profile**

Use `profile`, `profile_update`, `strategy_set`, and `strategy_analyze` to
inspect or change the mining profile.

**Wallet**

Use `wallets` and `wallet_attachment` to check the configured Mining wallet.

**Health and state**

Use `readiness`, `status`, `history`, and `recovery` for normal inspection.

**Runtime**

Use `start` and `stop` for mining participation.

**Capital and commit**

Use `capital_init`, `reserve_top_up`, `deposit_capital`,
`withdraw_capital`, and `set_commit` for miner capital.

**Cycle work**

Use `submit_cycle`, `participate`, `crank`, `settle_cycle_page`,
`score_cycle_page`, `distribute_cycle_page`, `finalize_cycle`, and
`finalize_epoch` for cycle execution.

**Claim and recovery**

Use `claim`, `claim_batch`, `recovery_claim`, `resolve_dispute`,
`republish_roots`, and `clear_history` after cycles settle or need recovery.

Use `sol` or `amountSol` for human SOL values, or `lamports` /
`amountLamports` for exact lamports.

Examples:

```text
Deposit 1 SOL into @mining capital.
Withdraw 0.25 SOL from @mining capital.
Set @mining active commit to 0.5 SOL.
Claim @mining for cycle 123.
Crank @mining cycle 123 page 0 and finalize if complete.
```

## Strategy control

`@mining` is an owner-only mining tool exposed to the agent. It is not a normal
Marketplace order tool and it is not the generic wallet send tool. The agent
can use this tool to inspect mining state, analyze history, set strategy fields,
and start or stop mining under the Mining wallet controls.

Fased can let the agent choose strategy in three levels:

1. `Deterministic` uses the selected preset without model planning.
2. `strategy_analyze` reads status and history and returns a recommendation.
3. `Auto` / `strategyMode: skill` lets the agent-planner path choose or adjust
   strategy, with fallback to deterministic behavior when planning fails.

Those are not three separate mining modes. The user-facing modes are
`Deterministic` and `Auto`. `Skill` is the model/agent source inside Auto.

The protocol still scores the submitted allocation on-chain. Agent strategy only
chooses the preset, execution mode, or advanced allocation input; it does not
bypass signer controls, wallet reserve checks, cycle settlement, or claim rules.

Mining strategy can be changed from chat:

```text
Set @mining strategy to balanced auto.
Ask @mining to analyze strategy from the last 24 hours.
If @mining recommends a safer strategy, set it and report why.
Set @mining strategy to spread deterministic and conservative risk.
Ask @mining to review history and recommend the next strategy.
```

Supported profile fields include:

**`strategyPreset`**

Supported values are `spread`, `balanced`, `conviction`, `swarm`, `top_k`,
`ranked`, `adaptive`, `crowd_aware`, and `safe_fallback`.

**`strategyExecution`**

Use `deterministic` or `auto`.

**`strategyMode`**

Use `base` or `skill`.

**`riskMode`**

Use `conservative`, `balanced`, `aggressive`, or `swarm`.

**`claimMode`**

Use `auto`, `prompt`, or `manual`.

**`autoClaim`**

Enable or disable automatic miner claim.

**`autoFinalizeEpoch`**

Enable or disable automatic epoch finalization.

**`satSweepEnabled`**

Enable or disable post-claim SAT sweep.

`strategy_analyze` reads mining status and history and returns a deterministic
recommendation. For model-guided strategy review, schedule an isolated agent
turn that asks the model to inspect status/history, then call `strategy_set`
with the chosen fields.

Useful strategy-analysis inputs are:

- current cycle participation, page count, and crowding
- free, locked, funded, safe commit, and target max
- recent SAT earned
- deterministic rebate and performance rebate
- net SOL cost after fees
- missed cycles, failed actions, and claim backlog
- previous strategy intent, execution mode, and fallback reason

Strategy analysis proves decision hygiene, not performance. A single
miner can prove that a preset runs, but strategy quality needs competitive
cycles where several miners submit different allocations into the same cycle
and the result is compared by SAT earned, deterministic rebate, performance
rebate, net SOL cost, score versus benchmark, and fallback reason.

If the task recommends a strategy while commit size is moving, first check
whether the commit changed because of locked capital or fee reserve. Strategy
review should not treat a safety-reduced commit as strategy performance.

Use task automation as a guarded strategy assistant:

```text
Every cycle, check @mining status and history. If there are at least 10 recent
settled cycles, recommend one of balanced, top_k, ranked, crowd_aware,
adaptive, or safe_fallback. Change strategy only if the expected reason is
clear, keep active commit unchanged, and report old strategy, new strategy,
fallback history, recent net SOL cost, and why the change is justified.
```

For early testing, prefer recommendations and explicit reports before allowing
the task to change strategy automatically.

For a strategy-only mining task, keep the prompt explicit:

```text
Every cycle, inspect @mining status/history only. You may change strategyPreset,
strategyExecution, and strategyMode. Do not use wallet, order, send,
route-action, bond, or web-search tools. Do not change active commit, target
max, capital, funding, withdraw, claim mode, or sweep settings. Report old
strategy, new strategy, reason, and whether active commit changed.
```

The safe planner result for that shape is:

- `allowedSkills=["mining"]`
- `memoryScope=none`
- mining source only
- no wallet source
- no web-search source
- no capital or commit mutation

The tested safety invariant is that a strategy-only task can change the strategy
profile while saved target commit and live active commit remain unchanged.

Do not include `claimMode`, `autoClaim`, or sweep fields in a strategy-only task
unless the task is explicitly a recovery or claim task. Strategy review should
leave miner claim settings unchanged.

Recommended Create Task fields for this mining strategy shape:

**Name**

`Mining strategy review`

**Prompt**

Use the strategy-only prompt above.

**Objective**

`Improve mining strategy selection without changing capital risk.`

**Success**

`Report old strategy, new strategy, reason, and confirm active commit stayed unchanged.`

**Session**

`New task session`

**Delivery target**

Use `No delivery` during testing, or choose a channel when you want reports.

**Execution**

Use `Auto` or `Agent turn`. Use `Skill-only` only for exact deterministic
mining tool calls.

**Memory**

Use `None` for strict isolated tests. Use `Session summary` or `Agent` only
when you intentionally want prior context.

**Skill access**

Use `Narrow selected skills` with `mining` only.

**Ask Agents**

Keep Ask Agents off for normal strategy runs. Use Consult/Parallel only when
you want other local Agents to review evidence.

The `Mining strategy review` Task template pre-fills those fields. Strategy
review is a scheduled Task because it has a recurring schedule, prompt,
execution settings, and safety limits. Workflow templates such as mining
readiness/start-gate review create a review flow instead of a recurring
strategy task. The execution model is a Task with mining-only access.

From the Mining page, use the `Task` button next to Strategy and Execution
to create the same strategy-only task without leaving the mining context. The
Mining history strategy analytics are the first place to check which strategy
was used most, whether task/skill strategy was active, whether auto fell back,
and how SAT/rebate/net SOL moved across settled cycles.

Useful mining-side Task templates:

**`Mining strategy review`**

Strategy-only review. It may change strategy fields only.

**`Mining status report`**

Read-only status, cycle, wallet balance, capital, locked, claimable, and
blockers.

**`Strategy A/B review`**

Strategy-only comparison across `balanced`, `top_k`, `ranked`, `crowd_aware`,
and `adaptive`.

**`Wallet reserve watch`**

Read-only reserve alert for Agent, Vault, and Mining wallets.

**`Staking claim watch`**

Read-only Fased Network staking report for bond, claimable SAT, distributor
pool, and vault.

Do not use Task templates for capital funding, withdraw, wallet sends, bond
top-up, custody, or Mining start/stop. Those remain page-owned actions with their
normal approval gates.

## Scheduled mining

Scheduled and conditional mining uses Tasks with isolated agent turns. The task
message tells the agent what to inspect and when to call the mining tool.

Examples:

```text
Every hour, check @mining status and history. Stop @mining if the pool has more
than 100 SOL and more than 10 miners. Start again when miners drop below 10.
```

```text
Every cycle, ask @mining to analyze my recent mining history and total pool
history. If the recommendation changes, update strategy before the next submit.
```

```text
At 22:00 every night, stop @mining, claim completed cycles, and report locked
capital, withdrawable capital, and SAT balance.
```

The recommended implementation pattern is:

1. create a disabled scheduled task
2. use `sessionTarget: "isolated"`
3. make the message explicit about wallet handle, thresholds, and action limits
4. enable only after the Mining wallet is configured, funded, and stable
5. review **Agent > Tasks** activity and Mining history after the first few runs

CLI example for an isolated strategy-only task:

```bash
TASK_MESSAGE="Every cycle, inspect @mining status/history only. \
You may change strategyPreset, strategyExecution, and strategyMode. \
Do not change active commit, target max, capital, funding, withdraw, \
claim mode, or sweep settings. Report old strategy, new strategy, reason, \
and whether active commit changed."

fased task add \
  --name "Mining strategy review" \
  --every 5m \
  --session isolated \
  --no-deliver \
  --message "$TASK_MESSAGE"
```

Mining remains controlled from the Mining page. Scheduled or workflow-driven
mining checks mirror readiness/start/stop/cycle/capital/recovery events into
Agent task history so **Agent > Tasks** can audit what happened and open the
source mining record, but Tasks does not bypass the Mining wallet, wallet
controls, or approval gates.

## Channel operation

The same `@mining` commands work from allowed channels. Channel configuration
still controls who can trigger the agent:

- direct-message allowlists
- group allowlists
- mention gating or trigger prefixes
- per-channel sessions
- task announcement targets

For channel commands, prefer explicit wording:

```text
@fased check @mining status only.
@fased stop @mining now.
@fased set @mining commit to 0.25 SOL and report readiness.
```

Avoid vague commands such as "fix mining" when the action could move capital or
change strategy.

## Mining wallet boundary

Use the Mining wallet for:

- Satcoin capital initialization
- deposit and withdraw miner capital
- active commit updates
- start and stop mining participation
- cycle submit/settle/score/distribute/finalize
- miner claim and recovery
- optional SAT sweep after claim

Use Agent wallets for ordinary chat sends, Marketplace payments, optional route
actions, and recurring wallet actions. Use a Vault wallet for Fased Network bond
authority and long-term storage.

## Related docs

- [Mining](/plugins/crypto/mining-page)
- [Advanced Satcoin mining](/plugins/crypto/mining-advanced)
- [Mining troubleshooting](/plugins/crypto/mining-troubleshooting)
- [Satcoin mining API and protocol](/plugins/crypto/mining-protocol)
- [Wallet Roles and Policies](/plugins/crypto/wallet-roles-and-policies)
- [Wallet Chat and Channels](/plugins/crypto/wallet-chat-and-channels)
- [Scheduled Tasks](/automation/cron-jobs)
