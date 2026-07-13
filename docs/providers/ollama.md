---
summary: "Run Fased with local, cloud, or hybrid Ollama"
read_when:
  - You want local Ollama models in Agent > Models
  - You need the correct Ollama native API URL
title: "Ollama"
---

# Ollama

Ollama is a first-class **Agent > Models** provider in Fased. It uses Ollama's
native API, not the OpenAI-compatible `/v1` endpoint.

Fased does not install Ollama and does not download Ollama model weights. Run
Ollama separately, then connect its API from **Agent > Models**.

Ollama support is built into the Fased core runtime. It does not appear in
`fased plugins list`, and no Ollama plugin needs to be installed.

Use a base URL like:

```bash
http://127.0.0.1:11434
```

Do **not** use:

```bash
http://127.0.0.1:11434/v1
```

The native API keeps tool calls and streaming behavior aligned with Ollama.

## Quick start

1. Install and start Ollama.
2. Pull a model:

```bash
ollama pull llama3.3
```

3. Open **Agents > selected Agent > Models > Ollama**.
4. Enter the native base URL, model ID, and optional API key.
5. Assign the model to the Agent's primary/fallback/task roles.

The Model ID field accepts either the raw Ollama ID (`qwen3:4b`) or the
provider-qualified ref (`ollama/qwen3:4b`). Fased stores one canonical
`ollama/qwen3:4b` reference.

For local-only Ollama, the API key can be blank in the UI. Fased stores a local
non-secret marker so the provider can be registered without exposing a real
credential to the Agent runtime.

## Discovery

When Ollama is explicitly configured, Fased can discover local models from:

```bash
GET http://127.0.0.1:11434/api/tags
```

The discovered model IDs appear as `ollama/<model-id>` refs. Costs are recorded
as `0` because local Ollama does not bill through a hosted provider.

The same setup path is available from onboarding and CLI:

```bash
fased providers connect ollama
fased models list --provider ollama --all
```

Provider configuration is shared with the selected Agent. You should not edit
`~/.fased/agents/<agent>/agent/models.json` manually; Fased regenerates that
runtime file from the canonical provider configuration.

## Windows Ollama with Fased in WSL2

First test the normal loopback URL from inside WSL2:

```bash
curl http://127.0.0.1:11434/api/tags
```

If that fails while Ollama is running on Windows, obtain the Windows host
address visible to that WSL2 distribution and test it directly:

```bash
ip route show default
curl http://WINDOWS_HOST_IP:11434/api/tags
```

Configure Ollama on Windows to listen on an address reachable from WSL2, then
use `http://WINDOWS_HOST_IP:11434` in Fased. Restrict Windows Firewall access
to the WSL virtual network or another trusted private network. Do not expose
port `11434` to the public internet.

After configuration, one model must appear consistently in all three checks:

```bash
fased models status
fased models list --provider ollama --all
fased models list --provider ollama
```

The Providers page, Agent role picker, Chat, and scheduled Tasks consume that
same model record. A Gateway restart is not normally required after setup.

## Config shape

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "ollama-local",
        request: { allowPrivateNetwork: true },
        models: [
          {
            id: "llama3.3",
            name: "llama3.3",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

`request.allowPrivateNetwork: true` is required because Ollama usually runs on
loopback, LAN, or a private tailnet host.

## Cloud and hybrid

If you use Ollama Cloud or a remote Ollama host that requires auth, provide a
real `OLLAMA_API_KEY` or save the key in **Agent > Models**. For a private LAN or
tailnet host, keep the native base URL and explicitly approve private-network
access.
