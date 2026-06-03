---
summary: "Chutes setup"
title: "Chutes"
read_when:
  - You want to use Chutes models
  - You need the provider id or auth env vars
---

# Chutes

Fased supports Chutes through an OpenAI-compatible endpoint.

| Property    | Value                                    |
| ----------- | ---------------------------------------- |
| Provider id | `chutes`                                 |
| Auth env    | `CHUTES_OAUTH_TOKEN` or `CHUTES_API_KEY` |
| API         | OpenAI-compatible                        |

## Where to set it up

Use the same Chutes methods in every setup surface:

| Surface    | What to do                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control UI | Open **Agents**, select an Agent, then use **Agent > Models**. Choose **Chutes**, then **Sign in** or **API key**, and assign the Agent's model roles there. Chat can override the model for the current session. |
| Onboarding | Choose **Set up model providers** only if you want provider setup during onboarding, then choose **Chutes** and pick **Sign in** or **API key**.                                                                  |
| CLI        | Use `fased onboard --auth-choice chutes` for sign-in, or `fased onboard --auth-choice chutes-api-key` for the interactive API-key path.                                                                           |

## Auth methods

### Sign in

Chutes sign-in uses Chutes OAuth. Chutes requires an OAuth app before Fased can
generate the sign-in URL. This is why the first prompt asks for a Chutes OAuth
client id such as `cid_...`.

Flow:

1. Create/register a Chutes OAuth app and get its client id (`cid_...`).
2. In Fased onboarding, CLI, or **Agent > Models**, choose **Chutes >
   Sign in**.
3. Paste the Chutes OAuth client id.
4. Fased generates the Chutes sign-in URL.
5. Open the URL, approve access, then let the local callback complete or paste
   the redirect URL if asked.

If you only want normal model access, use **API key** instead.

### Sign-in control UI setup

1. Open **Agents** and select the Agent.
2. Open **Agent > Models**.
3. Open **Chutes**.
4. Choose **Sign in**.
5. Paste the Chutes OAuth client id (`cid_...`).
6. Open or copy the sign-in URL shown in the modal.
7. Finish Chutes login in the browser.
8. Return to **Agent > Models** after the modal reports success, then choose a
   model role for the Agent or use Chat to override a single session.

### Sign-in onboarding setup

```bash
fased onboard
# choose: Set up model providers -> Chutes -> Sign in

# or start that auth choice directly
fased onboard --auth-choice chutes
```

### Sign-in CLI setup

```bash
fased onboard --auth-choice chutes
```

### API key

Create a Chutes API key (`cpk_...`) and paste it in **Agent > Models** or
the onboarding/CLI provider flow. Fased stores it as the `chutes` auth profile
and uses `https://llm.chutes.ai/v1` for OpenAI-compatible inference.

### API key control UI setup

1. Open **Agents** and select the Agent.
2. Open **Agent > Models**.
3. Open **Chutes**.
4. Use **API key** and paste a Chutes API key (`cpk_...`).
5. Choose the Agent's Chutes model roles.

### API key onboarding setup

```bash
fased onboard
# choose: Set up model providers -> Chutes -> API key

# or start the interactive API-key auth choice directly
fased onboard --auth-choice chutes-api-key
```

### API key CLI setup

```bash
# Interactive provider setup through onboarding
fased onboard --auth-choice chutes-api-key
```

Example default model:

```json5
{
  agents: { defaults: { model: { primary: "chutes/zai-org/GLM-5.1-TEE" } } },
}
```

Run `fased models list --all --provider chutes` to see the bundled catalog.
