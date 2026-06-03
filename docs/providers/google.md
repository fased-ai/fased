---
summary: "Google Gemini setup"
title: "Google Gemini"
read_when:
  - You want to use Gemini models
  - You need the provider id or API key env var
---

# Google Gemini

Fased supports Google Gemini with API-key auth and Gemini CLI OAuth.

| Property          | Value                                              |
| ----------------- | -------------------------------------------------- |
| Provider id       | `google`                                           |
| OAuth provider id | `google-gemini-cli`                                |
| Auth env          | `GEMINI_API_KEY`                                   |
| API               | Google Generative AI                               |
| Base URL          | `https://generativelanguage.googleapis.com/v1beta` |

Example default model:

```json5
{
  agents: { defaults: { model: { primary: "google/gemini-3.1-pro-preview" } } },
}
```

Run `fased models list --all --provider google` to see the bundled catalog.

## Setup methods

### Gemini API key

Use this for the normal Google Generative AI API path. It works in:

- Onboarding: choose **Google** -> **Gemini API key**.
- CLI: run the provider auth command for Google API key setup, or set `GEMINI_API_KEY`.
- Control UI: open **Agents**, select an Agent, then use **Agent > Models** ->
  **Google** -> **API key** and save the key.

No local CLI install is required for API-key setup.

### Sign in (Gemini CLI)

This is a separate `google-gemini-cli` route. It is an unofficial OAuth flow and
is not endorsed by Google. Onboarding shows the account-risk warning before
continuing, and **Agent > Models** shows the same prerequisite on the Google
sign-in card.

Before using this method in onboarding, CLI, or the Control UI, make sure the
gateway machine has one of these:

- `gemini-cli` installed and available on `PATH`, for example
  `npm install -g @google/gemini-cli` or `brew install gemini-cli`.
- `GEMINI_CLI_OAUTH_CLIENT_ID` set in the gateway environment.

In a remote/VPS environment, the flow shows a URL to open in your local browser.
After signing in, paste the redirect URL back if the wizard asks for it. If the
dependency is missing, setup fails with the same message in onboarding, CLI, and
UI: install Gemini CLI or set `GEMINI_CLI_OAUTH_CLIENT_ID`.
