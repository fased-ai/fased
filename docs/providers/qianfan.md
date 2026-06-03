---
summary: "Use Qianfan's unified API to access many models in Fased"
read_when:
  - You want a single API key for many LLMs
  - You need Baidu Qianfan setup guidance
title: "Qianfan"
---

# Qianfan Provider Guide

Qianfan is Baidu's MaaS platform, provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Prerequisites

1. A Baidu Cloud account with Qianfan API access
2. An API key from the Qianfan console
3. Fased installed on your system

## Getting Your API Key

1. Visit the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Create a new application or select an existing one
3. Generate an API key (format: `bce-v3/ALTAK-...`)
4. Copy the API key for use with Fased

## CLI setup

```bash
fased onboard --auth-choice qianfan-api-key
```

The normal setup surfaces now use the same Qianfan auth method:

- Onboarding: `Qianfan` -> `Qianfan API key`
- CLI: `fased onboard --auth-choice qianfan-api-key`
- UI: **Agent > Models** -> `Qianfan` -> `Qianfan API key`

The first-run model list is curated from Qianfan's current model table:

- `qianfan/ernie-5.1` default flagship
- `qianfan/ernie-5.0`
- `qianfan/ernie-5.0-thinking-latest`
- `qianfan/ernie-5.0-thinking-preview`
- `qianfan/ernie-x1.1`
- `qianfan/ernie-x1-turbo-32k`
- `qianfan/deepseek-v4-pro`
- `qianfan/deepseek-v4-flash`
- `qianfan/deepseek-v3.2`

## Related Documentation

- [Fased Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Agent Setup](/concepts/agent)
- [Qianfan API Documentation](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
- [Qianfan Model List](https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j)
