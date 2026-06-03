---
summary: "Sign in to GitHub Copilot from Fased using the device flow"
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `fased models auth login-github-copilot` flow
title: "GitHub Copilot"
---

# GitHub Copilot

## What is GitHub Copilot?

GitHub Copilot is GitHub's AI coding assistant. It provides access to Copilot
models for your GitHub account and plan. Fased can use Copilot as a model
provider in two different ways.

GitHub Copilot is a current Fased model provider route. It is separate from
GitHub repository integrations or the GitHub plugin connector; this page only
covers model access.

## Two ways to use Copilot in Fased

### 1) Built-in GitHub Copilot provider (`github-copilot`)

Use the native device-login flow to obtain a GitHub token, then exchange it for
Copilot API tokens when Fased runs. This is the **default** and simplest path
because it does not require VS Code.

### 2) Copilot Proxy plugin (`copilot-proxy`)

Use the **Copilot Proxy** VS Code extension as a local bridge. Fased talks to
the proxy’s `/v1` endpoint and uses the model list you configure there. Choose
this when you already run Copilot Proxy in VS Code or need to route through it.
You must enable the plugin and keep the VS Code extension running.

## CLI setup

```bash
fased models auth login-github-copilot
```

You'll be prompted to visit a URL and enter a one-time code. Keep the terminal
open until it completes.

### Optional flags

```bash
fased models auth login-github-copilot --profile-id github-copilot:work
fased models auth login-github-copilot --yes
```

## Choose a model

For normal browser setup, open **Agents**, select the Agent, then use **Agent >
Models** to choose a GitHub Copilot model for primary, fallback, or task work.

For CLI setup, you can set the default model:

```bash
fased models set github-copilot/gpt-5.5
```

### Config snippet

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-5.5" } } },
}
```

## Notes

- Requires an interactive TTY; run it directly in a terminal.
- Copilot model availability depends on your plan; if a model is rejected, try
  another current Copilot model ID (for example `github-copilot/gpt-5.4`
  or `github-copilot/claude-sonnet-4.6`).
- The login stores a GitHub token in the auth profile store and exchanges it for a
  Copilot API token when Fased runs.
