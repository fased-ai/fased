---
summary: "Use MiniMax M2.7 in Fased"
read_when:
  - You want MiniMax models in Fased
  - You need MiniMax setup guidance
title: "MiniMax"
---

# MiniMax

MiniMax is a normal **Agent > Models** provider in Fased. The code registry
currently exposes these MiniMax routes:

| Route            | Use                                         |
| ---------------- | ------------------------------------------- |
| `minimax`        | Global MiniMax API key route.               |
| `minimax-cn`     | China MiniMax API key route.                |
| `minimax-portal` | MiniMax Coding Plan / portal sign-in route. |

The current normal model refs are based on **MiniMax M2.7** and **M2.5**.

## Recommended Setup

Open **Agents**, select the Agent, then use **Agent > Models > MiniMax**.

You can choose:

- **Sign in** for the MiniMax portal/coding-plan route.
- **API key** for the hosted Global or CN route.
- **Highspeed API key** when you have the highspeed MiniMax route.

CLI users can run:

```bash
fased configure
```

Then choose the model provider/auth setup section and select MiniMax.

## Model Refs

Use model refs from the registry:

```text
minimax/MiniMax-M2.7
minimax/MiniMax-M2.7-highspeed
minimax/MiniMax-M2.5
minimax/MiniMax-M2.5-highspeed
minimax-portal/MiniMax-M2.7
minimax-portal/MiniMax-M2.7-highspeed
```

Check the active local catalog with:

```bash
fased models list --all --provider minimax
fased models list --all --provider minimax-portal
```

## API Key Example

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.7" },
    },
  },
}
```

Use `MINIMAX_CN_API_KEY` for the CN route and `MINIMAX_HIGHSPEED_API_KEY` when
you want the highspeed route.

## Portal Sign-In

The portal route uses the bundled MiniMax portal auth helper. From the UI, use
**Agent > Models > MiniMax > Sign in**. From the CLI, enable the plugin if
needed and run the auth flow:

```bash
fased plugins enable minimax-portal-auth
fased gateway restart
fased onboard --auth-choice minimax-portal
```

The flow shows a MiniMax approval URL and user code. Complete the approval in
the browser, then return to Fased.

## Fallback Example

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-7": { alias: "opus" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
    },
  },
}
```

## Local MiniMax Files

MiniMax through LM Studio or another local server is not the normal MiniMax
provider route. Use [LM Studio](/providers/lmstudio) when the model is served by
LM Studio, or [Custom Provider](/providers/custom) for another local
OpenAI-compatible endpoint.

## Troubleshooting

### Unknown MiniMax model

Run:

```bash
fased models list --all --provider minimax
```

Then choose one of the listed refs. If the route is missing, add a MiniMax
credential in **Agent > Models** or rerun `fased configure`.

### Portal sign-in does not appear

Confirm the `minimax-portal-auth` plugin is enabled and the gateway has been
restarted after enabling it.
