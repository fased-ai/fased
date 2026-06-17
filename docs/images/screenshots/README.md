# Screenshot And Video Capture Checklist

Use this folder for Fased Agent UI screenshots and short videos referenced from
public docs. Keep brand/static files in `docs/assets`; keep doc screenshots here.

This checklist is written as the capture runbook for:

- [Agent, Wallets, And Mining Walkthrough](/start/agent-wallet-mining-walkthrough)
- [Getting Started](/start/getting-started)
- [Control UI Setup Model](/start/control-ui-setup)
- [Wallets](/plugins/crypto/wallet-page)
- [Mining](/plugins/crypto/mining-page)
- [Fased Network](/start/federation)

## Capture Setup

Use the local devnet profile for wallet and mining captures.

Recommended browser state:

- dark theme
- desktop width first, about `1440x1000`
- zoom `100%`
- browser sidebars closed
- local URL only, such as `http://localhost:18789`

Use focused screenshots. Full-page captures are useful only when the page layout
itself is the point.

Do not show:

- API keys
- recovery material
- private keys or seed phrases
- production wallet addresses
- production balances
- private RPC keys if visible in the UI

Devnet addresses and devnet balances are acceptable when the screenshot topic
needs the user to see what the page looks like.

## Naming

Use lowercase kebab-case:

```text
docs/images/screenshots/<area>/<page-or-flow>-<state>.png
docs/images/screenshots/videos/<area>/<flow>.webm
```

Examples:

```text
docs/images/screenshots/install/control-ui-first-open.png
docs/images/screenshots/wallet/wallet-overview-devnet.png
docs/images/screenshots/mining/mining-readiness.png
docs/images/screenshots/videos/mining/readiness-deposit-start.webm
```

Reference screenshots from docs as:

```md
![Mining readiness](/images/screenshots/mining/mining-readiness.png)
```

Reference videos only when motion helps:

```md
<video controls src="/images/screenshots/videos/mining/readiness-deposit-start.webm" />
```

## Capture Order

Capture in this order so screenshots line up with a real user story:

1. Install and first open
2. Agent setup
3. Model and first chat
4. Wallet creation
5. Wallet funding and wallet operations
6. Mining readiness
7. Mining capital and commit
8. Start, stop, claim, sweep
9. Fased Network and bond
10. Tasks, automation, and Marketplace

## Priority Legend

- **P0:** required for the first public walkthrough
- **P1:** useful for wallet/mining detail docs
- **P2:** later supporting docs or advanced operator docs

## P0 Walkthrough Screens

These are the first screenshots to capture for the beginner path.

| Priority | File                                             | Fased page            | Action to capture                                                | Topic                                  | Use in docs                                |
| -------- | ------------------------------------------------ | --------------------- | ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| P0       | `install/control-ui-first-open.png`              | `/` or dashboard home | Open `fased dashboard` and land in Control UI                    | First browser entry                    | `/start/getting-started`, walkthrough      |
| P0       | `start/agent-setup-checklist.png`                | `/agents`             | Open the selected Agent setup checklist                          | Where setup continues after onboarding | `/start/control-ui-setup`, walkthrough     |
| P0       | `start/model-connected.png`                      | `Agent > Models`      | Show provider connected and primary model selected               | Model ready before wallet/mining       | walkthrough                                |
| P0       | `start/first-chat.png`                           | Chat                  | Send a simple test message and show response                     | First working Agent                    | `/start/getting-started`, walkthrough      |
| P0       | `wallet/wallet-empty-state.png`                  | `/wallet`             | Open Wallets before wallet creation or with setup prompt visible | Wallet entry point                     | walkthrough                                |
| P0       | `wallet/wallet-create-agent.png`                 | `/wallet`             | Open wallet creation with Agent role selected                    | Create Agent wallet                    | walkthrough, wallet docs                   |
| P0       | `wallet/wallet-create-mining.png`                | `/wallet`             | Open wallet creation with Mining role selected                   | Create Mining wallet                   | walkthrough, mining docs                   |
| P0       | `wallet/wallet-create-vault.png`                 | `/wallet`             | Open wallet creation with Vault role selected                    | Create Vault wallet                    | walkthrough, Fased Network docs            |
| P0       | `wallet/wallet-overview-devnet.png`              | `/wallet`             | Show Agent, Mining, and Vault cards after creation               | Wallet role separation                 | `/plugins/crypto/wallet-page`, walkthrough |
| P0       | `wallet/wallet-copy-mining-address.png`          | `/wallet`             | Open/click copy address on Mining wallet card                    | Fund Mining wallet                     | walkthrough                                |
| P0       | `wallet/wallet-mining-funded-devnet.png`         | `/wallet`             | Show Mining wallet after devnet SOL arrives                      | Funded wallet                          | walkthrough                                |
| P0       | `mining/mining-overview-devnet.png`              | `/mining`             | Open Mining page with `@wallet:mining` visible                   | Mining page orientation                | `/plugins/crypto/mining-page`, walkthrough |
| P0       | `mining/mining-readiness.png`                    | `/mining`             | Run readiness and show ready or fixable warnings                 | Pre-start checks                       | walkthrough, troubleshooting               |
| P0       | `mining/mining-fund-capital.png`                 | `/mining`             | Open Fund/Deposit capital control before submit                  | Capital deposit                        | walkthrough                                |
| P0       | `mining/mining-capital-funded.png`               | `/mining`             | Show capital after deposit                                       | Capital ready                          | walkthrough                                |
| P0       | `mining/mining-set-commit.png`                   | `/mining`             | Edit active commit target                                        | Set commit                             | walkthrough                                |
| P0       | `mining/mining-running.png`                      | `/mining`             | Click Start and show running status                              | Mining started                         | walkthrough                                |
| P0       | `mining/mining-recent-activity.png`              | `/mining`             | Show recent activity/history after cycles                        | Confirm runtime work                   | walkthrough                                |
| P0       | `mining/mining-stop-clearing.png`                | `/mining`             | Click Stop and show clearing/stopped state                       | Stop mining                            | walkthrough                                |
| P0       | `wallet/wallet-recent-activity-after-mining.png` | `/wallet`             | Return to Wallets and show recent wallet activity                | Wallet audit after mining              | walkthrough                                |

## P1 Wallet Operations Screens

Capture these after the P0 path works.

| Priority | File                                 | Fased page | Action to capture                                     | Topic                            | Use in docs                                 |
| -------- | ------------------------------------ | ---------- | ----------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| P1       | `wallet/wallet-access-tab.png`       | `/wallet`  | Open Access tab                                       | Passkey and wallet-control entry | `/plugins/crypto/wallet-page`               |
| P1       | `wallet/wallet-passkey-setup.png`    | `/wallet`  | Open passkey setup or ready state                     | Wallet Control Passkey           | `/plugins/crypto/wallet-control-passkey`    |
| P1       | `wallet/wallet-policy-panel.png`     | `/wallet`  | Open selected wallet controls and caps                | Wallet policy                    | `/plugins/crypto/wallet-roles-and-policies` |
| P1       | `wallet/wallet-agent-send-form.png`  | `/wallet`  | Fill send form from Agent wallet without broadcasting | Reviewed send                    | `/plugins/crypto/wallet-page`               |
| P1       | `wallet/wallet-approval-request.png` | `/wallet`  | Create approval request and show pending diff         | Manual approval                  | wallet docs                                 |
| P1       | `wallet/wallet-passkey-approval.png` | `/wallet`  | Show passkey approval prompt or ceremony state        | Approval auth                    | passkey docs                                |
| P1       | `wallet/wallet-activity-detail.png`  | `/wallet`  | Open recent activity detail                           | Audit trail                      | wallet docs                                 |
| P1       | `wallet/wallet-skill-grants.png`     | `/wallet`  | Open Skill Grants tab                                 | Wallet-capable skills            | wallet docs                                 |
| P1       | `wallet/wallet-vault-security.png`   | `/wallet`  | Open Vault Security panel                             | Vault role                       | wallet docs                                 |
| P1       | `wallet/wallet-mining-sweep.png`     | `/wallet`  | Open Mining wallet Sweep controls                     | Mining-only sweep                | mining docs                                 |

## P1 Mining Operations Screens

Capture these for the dedicated mining docs.

| Priority | File                                  | Fased page | Action to capture                                | Topic                | Use in docs                              |
| -------- | ------------------------------------- | ---------- | ------------------------------------------------ | -------------------- | ---------------------------------------- |
| P1       | `mining/mining-readiness-warning.png` | `/mining`  | Show a fixable readiness warning                 | Troubleshooting      | `/plugins/crypto/mining-troubleshooting` |
| P1       | `mining/mining-safe-commit.png`       | `/mining`  | Show target above safe commit and reduced submit | Safe commit          | mining docs                              |
| P1       | `mining/mining-commit-updated.png`    | `/mining`  | Show active commit after Update                  | Commit write         | mining docs                              |
| P1       | `mining/mining-current-cycle.png`     | `/mining`  | Show current cycle and commit cards              | Cycle state          | mining docs                              |
| P1       | `mining/mining-history.png`           | `/mining`  | Show history table/summary                       | Mining history       | `/plugins/crypto/mining-advanced`        |
| P1       | `mining/mining-claim-ready.png`       | `/mining`  | Show claimable SAT state                         | Claim                | mining docs                              |
| P1       | `mining/mining-claim-complete.png`    | `/mining`  | Show claim completed in activity                 | Claim proof          | mining docs                              |
| P1       | `mining/mining-sweep-settings.png`    | `/mining`  | Open sweep settings                              | Sweep                | mining automation docs                   |
| P1       | `mining/mining-share-summary.png`     | `/mining`  | Open screenshot-safe Share modal                 | Public/share summary | mining automation docs                   |
| P1       | `mining/mining-recovery-panel.png`    | `/mining`  | Open Recovery panel                              | Recovery             | troubleshooting                          |

## P1 Fased Network Screens

Capture these after wallets and mining are understandable.

| Priority | File                                     | Fased page                      | Action to capture                            | Topic               | Use in docs                    |
| -------- | ---------------------------------------- | ------------------------------- | -------------------------------------------- | ------------------- | ------------------------------ |
| P1       | `network/fased-network-status.png`       | `/federation`                   | Show handle, token, route, and market status | Network status      | `/start/federation`            |
| P1       | `network/fased-network-route-health.png` | `/federation`                   | Show public route/hosted health              | Public reachability | `/start/federation`            |
| P1       | `network/bond-operator-card.png`         | `/federation`                   | Show Vault wallet and bond state             | Bond operator       | `/start/bond-operator-economy` |
| P1       | `network/bond-top-up.png`                | `/federation`                   | Open top-up action without submitting        | Bond top-up         | bond docs                      |
| P1       | `network/staking-card.png`               | `/federation`                   | Show claimable/pool values                   | Staking distributor | bond docs                      |
| P1       | `network/offers-local-list.png`          | `/federation` or `/marketplace` | Show compact local offers                    | Offers              | `/start/offers-marketplace`    |

## P2 Tasks, Automation, And Marketplace Screens

These help after the wallet/mining walkthrough is complete.

| Priority | File                                      | Fased page              | Action to capture                     | Topic             | Use in docs                          |
| -------- | ----------------------------------------- | ----------------------- | ------------------------------------- | ----------------- | ------------------------------------ |
| P2       | `tasks/tasks-definitions.png`             | `Agent > Tasks`         | Show saved task definitions           | Tasks             | `/concepts/agents-sessions-tasks`    |
| P2       | `tasks/task-template-mining-strategy.png` | `Agent > Tasks`         | Open mining strategy task template    | Mining automation | mining automation docs               |
| P2       | `tasks/trigger-modal.png`                 | `Agent > Tasks`         | Open trigger setup modal              | Triggers          | `/automation/webhook`                |
| P2       | `marketplace/marketplace-listings.png`    | `/marketplace`          | Show compact listings and filters     | Marketplace       | `/start/offers-marketplace`          |
| P2       | `marketplace/order-evidence.png`          | `/marketplace`          | Open order evidence and receipt state | Order evidence    | marketplace docs                     |
| P2       | `security/wallet-security-state.png`      | `/wallet`               | Show wallet security state            | Security posture  | `/security/security-test-report`     |
| P2       | `security/signer-doctor-result.png`       | `/wallet` or CLI output | Show signer health result             | Signer health     | `/plugins/crypto/wallet-self-hosted` |

## Video Capture List

Videos should be short, silent, and focused. Use screenshots for static docs and
videos only when a user benefits from seeing the sequence.

| Priority | File                                                 | Fased page                 | Action to record                                          | Topic               | Use in docs |
| -------- | ---------------------------------------------------- | -------------------------- | --------------------------------------------------------- | ------------------- | ----------- |
| P0       | `videos/start/open-dashboard-first-chat.webm`        | dashboard, `/agents`, Chat | Open dashboard, select Agent, send first chat             | First working Agent | walkthrough |
| P0       | `videos/wallet/create-wallets-and-copy-address.webm` | `/wallet`                  | Create Agent/Mining/Vault wallets and copy Mining address | Wallet setup        | walkthrough |
| P0       | `videos/mining/readiness-deposit-start.webm`         | `/mining`                  | Run readiness, fund capital, set commit, start            | Mining start        | walkthrough |
| P1       | `videos/wallet/send-approval-flow.webm`              | `/wallet`                  | Create reviewed send request and approve                  | Wallet ops          | wallet docs |
| P1       | `videos/mining/stop-claim-history.webm`              | `/mining`                  | Stop, claim if ready, review history                      | Mining closeout     | mining docs |
| P1       | `videos/network/bond-top-up-claim.webm`              | `/federation`              | Open bond top-up and staking claim flow                   | Bond ops            | bond docs   |

## Capture Notes By Topic

### Install

Show enough of onboarding for the user to understand Local vs Hosting. Avoid
capturing terminal scrollback with shell history or private paths beyond the repo
and normal local dashboard URL.

### Agent Setup

The important screenshots are `/agents`, `Agent > Models`, and Chat. The user
should understand that wallet/mining work comes after a working Agent.

### Wallets

Show the three wallet roles clearly:

- Agent wallet for reviewed sends, receipts, Marketplace, and wallet-capable
  skills.
- Mining wallet for Satcoin mining only.
- Vault wallet for protected storage and Fased Network bond authority.

Show wallet controls, approval requests, and recent activity as separate
screens. They answer different user questions.

### Mining

Show the order: readiness, capital, commit, start, history, stop, claim, sweep.
Do not start with advanced strategy panels. The first-time user needs to see
that Mining is an operator page with a safe sequence.

### Fased Network

Show Fased Network only after base wallet/mining screenshots exist. The user
should understand the base Agent before public route, bond, and staking screens.

### Marketplace And Tasks

Capture these after wallet/mining. They are important, but they should not make
the first walkthrough feel like the user must configure every Fased feature on
day one.

## Screenshot Acceptance Checklist

Before adding a screenshot to public docs:

- The screenshot matches the current UI labels.
- The page is in dark theme.
- The intended action is obvious without extra arrows.
- No private key, seed, API key, or recovery material is visible.
- Devnet/test values are acceptable for the topic.
- The image is focused enough to be readable in docs.
- The filename matches this README.
- The docs page that uses the screenshot has a short caption explaining it.

## Recapture Triggers

Recapture screenshots when:

- UI labels change.
- Wallet role names change.
- Mining status labels change.
- The first-run flow changes.
- The page layout changes enough that the old screenshot teaches the wrong path.
- Mainnet launch changes public Satcoin wording, but keep screenshots on a
  screenshot-safe profile unless a mainnet proof page specifically needs a
  real public explorer value.
