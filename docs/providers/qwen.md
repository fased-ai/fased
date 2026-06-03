---
summary: "Use Qwen API keys and Coding Plan in Fased"
read_when:
  - You want to use Qwen with Fased
  - You need the current Qwen setup methods
title: "Qwen"
---

# Qwen

Fased normal setup supports Qwen through API keys:

- **Coding Plan API key**: Alibaba Cloud Coding Plan key (`sk-sp-...`), higher
  quota and premium coding models.
- **DashScope API key**: standard Qwen/DashScope API key (`sk-...`) for
  pay-as-you-go compatible-mode API access.

Qwen Code's old OAuth free tier was discontinued on 2026-04-15. Fased no longer
offers that legacy Qwen portal sign-in in onboarding, CLI provider setup, or
**Agent > Models**.

## Setup

Use any normal setup surface:

- Onboarding: choose **Qwen**, then **Coding Plan API key** or **DashScope API key**.
- Control UI: open **Agents**, select an Agent, then use **Agent > Models** ->
  **Qwen** and save the matching API key.
- CLI: use the Qwen provider API-key setup path or set the matching environment key.

For Qwen Cloud API keys, Qwen's docs distinguish general pay-as-you-go keys
(`sk-...`) from Coding Plan keys (`sk-sp-...`). Use the Coding Plan method for
`sk-sp-...` keys.

## Model refs

Examples:

- `qwen-coding-plan/qwen3.6-plus`
- `qwen-coding-plan/qwen3-coder-plus`
- `qwen/qwen3.6-plus`
- `qwen/qwen3-coder-plus`

Run `fased models list --all --provider qwen` to inspect the current catalog.
