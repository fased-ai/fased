---
summary: "Use Mistral models and Voxtral transcription with Fased"
read_when:
  - You want to use Mistral models in Fased
  - You need Mistral API key onboarding and model refs
title: "Mistral"
---

# Mistral

Fased supports Mistral for both text/image model routing (`mistral/...`) and
audio transcription via Voxtral in media understanding.
Mistral can also be used for memory embeddings (`memorySearch.provider = "mistral"`).

## CLI setup

```bash
fased onboard --auth-choice mistral-api-key
# or non-interactive
fased onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## Config snippet (LLM provider)

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-medium-3.5" } } },
}
```

Normal first-run surfaces show the current Mistral API chat models:

- `mistral/mistral-medium-3.5`
- `mistral/mistral-small-2603`
- `mistral/mistral-large-2512`
- `mistral/mistral-medium-2508`
- `mistral/devstral-2512`
- `mistral/magistral-medium-2509`
- `mistral/magistral-small-2509`
- `mistral/ministral-14b-2512`
- `mistral/ministral-8b-2512`
- `mistral/ministral-3b-2512`

Older aliases such as `mistral-large-latest` and older Codestral-era choices
are not shown in normal setup. Existing explicit configs are not removed
automatically.

`mistral-medium-3.5`, `mistral-small-2603`, and `magistral-medium-2509`
surface reasoning controls. Fased maps its thinking levels to the Mistral API's
`reasoning_effort` values (`high` or `none`) before sending requests.

## Config snippet (audio transcription with Voxtral)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## Notes

- Mistral auth uses `MISTRAL_API_KEY`.
- Provider base URL defaults to `https://api.mistral.ai/v1`.
- Onboarding default model is `mistral/mistral-medium-3.5`.
- Media-understanding default audio model for Mistral is `voxtral-mini-latest`.
- Media transcription path uses `/v1/audio/transcriptions`.
- Memory embeddings path uses `/v1/embeddings` (default model: `mistral-embed`).
