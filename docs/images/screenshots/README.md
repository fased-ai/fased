# Screenshot Asset Plan

Use this folder for Fased Agent UI screenshots referenced from public docs.
Keep brand/static files in `docs/assets`; keep doc screenshots here.

## Naming

Use lowercase kebab-case:

```text
docs/images/screenshots/<area>/<page-or-flow>-<state>.png
```

Examples:

```text
docs/images/screenshots/install/install-local-first-run.png
docs/images/screenshots/wallet/wallet-overview-redacted.png
docs/images/screenshots/mining/mining-overview-redacted.png
```

Reference screenshots from docs as:

```md
![Mining overview](/images/screenshots/mining/mining-overview-redacted.png)
```

## Capture Rules

- Use the dark theme unless a page specifically explains light theme.
- Capture desktop width first; add mobile only when layout behavior matters.
- Redact wallet addresses, RPC endpoints, API keys, machine names, and full
  balances unless the page specifically needs them.
- Prefer focused screenshots over full-page captures.
- Re-capture screenshots when UI layout, labels, or visible data changes.

## Recommended Set

### Install

| File                                  | Shows                               | Good docs page                    |
| ------------------------------------- | ----------------------------------- | --------------------------------- |
| `install/install-local-first-run.png` | local install path and first launch | `/install`                        |
| `install/install-hosting-profile.png` | hosting profile choice              | `/install`, `/start/setup-matrix` |
| `install/onboarding-setup-map.png`    | Local vs Hosting setup map          | `/start/setup-matrix`             |
| `install/control-ui-first-open.png`   | first Control UI landing state      | `/start/getting-started`          |

### Wallet

| File                                  | Shows                                | Good docs page                              |
| ------------------------------------- | ------------------------------------ | ------------------------------------------- |
| `wallet/wallet-overview-redacted.png` | wallet cards with hidden address/RPC | `/plugins/crypto/wallet-page`               |
| `wallet/wallet-role-create.png`       | Agent, Mining, Vault role choice     | `/plugins/crypto/wallet-roles-and-policies` |
| `wallet/wallet-policy-panel.png`      | policy/caps/grants surface           | `/plugins/crypto/wallet-roles-and-policies` |
| `wallet/wallet-passkey-approval.png`  | passkey approval prompt              | `/plugins/crypto/wallet-control-passkey`    |

### Mining

| File                                  | Shows                                            | Good docs page                               |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| `mining/mining-overview-redacted.png` | start/stop/status, redacted wallet, balances     | `/plugins/crypto/mining-page`                |
| `mining/mining-capital-controls.png`  | strategy, execution, task, target, fund/withdraw | `/plugins/crypto/mining-page`                |
| `mining/mining-history-analysis.png`  | strategy analytics and history summary           | `/plugins/crypto/mining-advanced`            |
| `mining/mining-share-summary.png`     | screenshot-safe Share modal                      | `/plugins/crypto/mining-chat-and-automation` |

### Fased Network

| File                               | Shows                             | Good docs page                 |
| ---------------------------------- | --------------------------------- | ------------------------------ |
| `network/fased-network-status.png` | handle, live/bond/market status   | `/start/federation`            |
| `network/bond-operator-card.png`   | Vault wallet, bond, top-up/unlock | `/start/bond-operator-economy` |
| `network/staking-card.png`         | claimable and pool values         | `/start/bond-operator-economy` |

### Tasks And Automation

| File                                      | Shows                                       | Good docs page                               |
| ----------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `tasks/tasks-definitions.png`             | saved definitions separate from run history | `/concepts/agents-sessions-tasks`            |
| `tasks/task-template-mining-strategy.png` | mining strategy template filled in          | `/plugins/crypto/mining-chat-and-automation` |
| `tasks/trigger-modal.png`                 | trigger setup modal                         | `/automation/webhook`                        |

### Marketplace

| File                                   | Shows                              | Good docs page              |
| -------------------------------------- | ---------------------------------- | --------------------------- |
| `marketplace/marketplace-listings.png` | compact listings and filters       | `/start/offers-marketplace` |
| `marketplace/order-evidence.png`       | payment evidence and receipt state | `/start/offers-marketplace` |

### Security

| File                                 | Shows                       | Good docs page                       |
| ------------------------------------ | --------------------------- | ------------------------------------ |
| `security/wallet-security-state.png` | passkey/split-key readiness | `/security/security-test-report`     |
| `security/signer-doctor-result.png`  | signer health summary       | `/plugins/crypto/wallet-self-hosted` |
