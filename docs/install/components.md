---
summary: "What the signed Fased generation includes and what remains external."
read_when:
  - You want to know what a fresh Fased install includes
  - You are adding chat channels, local models, browser control, or local embeddings
  - You need to understand what fased update does with add-ons
title: "Core And External Components"
sidebarTitle: "Core And External"
---

# Core and external components

The signed Fased generation contains the Agent, crypto path, official channels,
and Fased-owned runtime components. Components may remain disabled until you
choose them, but enabling one does not download code from npm.

Inspect the current machine from the CLI:

```bash
fased components
fased services status
```

The Control UI shows the same lifecycle report under **Services > Components**.
`included`, `installed`, `configured`, and `ready` are separate states. A
configuration field does not mean its runtime is installed or healthy.

Each component row exposes only applicable actions:

- **Enable** activates a bundled Fased component.
- **Restart** reloads an enabled component through the Gateway service.
- **Connect** opens the owning setup surface.
- **Open docs** opens the canonical setup page.

The matching CLI entry points are:

```bash
fased services status
fased services connect <component-id>
fased services install <component-id>
```

## Included in core

A normal install includes:

- Gateway, Control UI, browser Chat, Agents, Tasks, Tools, and provider clients
- Solana wallet controls and the singleton Mining wallet flow
- the bundled `sat-mining` runtime, SAT shared specs, Mining UI, and mining CLI
- Fased Network, offers, requests, trust, bond, and marketplace controls
- browser-control interfaces and the Fased browser extension files
- file-backed memory and remote embedding-provider support

The bundled `sat-mining` runtime is included and loaded with core. Creating or
importing `@wallet:mining` through onboarding attaches the dedicated Mining
wallet and makes readiness checks available. Do not install a separate mining
package and do not run `fased plugins enable sat-mining` as the normal mining
setup path. Mining does not start until readiness, capital, and commit checks
pass and the operator explicitly starts it.

## Bundled official channels

Telegram, WhatsApp, Discord, Slack, Feishu/Lark, and Google Chat are official
bundled integrations. They are part of every signed generation and update with
the core application.

The normal browser flow is:

1. Open **Agents > selected Agent > Channels**.
2. Select the channel.
3. Click **Enable**.
4. Restart the Gateway when prompted.
5. Return to the channel card and enter its token or complete its login flow.

The onboarding wizard and `fased channels add` enable the same bundled code.

CLI enablement is also available:

```bash
fased components install telegram
fased components install whatsapp
fased components install discord
fased components install slack
fased components install feishu
fased components install googlechat
fased gateway restart
```

Enable only the channels you use. Their code and production dependencies remain
bound to the same verified Fased release identity.

<Note>
Independent third-party extensions are not part of the Fased generation. They
must use the separate verified extension flow described on their own page;
Fased-owned channel packages are never resolved from npm at runtime.
</Note>

## Bundled runtime components

Enable these only when the related feature is needed:

```bash
fased components install browser-runtime
fased components install media-runtime
fased components install speech-runtime
fased components install local-memory-runtime
fased components install openai-runtime
fased gateway restart
```

- **Browser Runtime** provides Playwright control and readable-page extraction.
- **Media Runtime** provides image transforms, file-type detection, and PDF extraction.
- **Speech Runtime** provides the Edge TTS client. OpenAI and ElevenLabs API speech
  do not require this local package.
- **Local Vector Memory** provides native sqlite vector acceleration. File-backed
  memory and remote embedding providers remain in core.
- **OpenAI Sign-In Runtime** provides the official OpenAI Codex app-server used to
  discover and execute models available to a ChatGPT sign-in. Direct OpenAI API
  key models do not require this component.

These private workspace packages are assembled into the verified generation.
`fased update` swaps their code and dependencies with the core in one
transaction; there is no independent npm version or install ledger.

## Local models stay external

Fased includes provider clients for Ollama, LM Studio, vLLM, LiteLLM, and custom
OpenAI-compatible endpoints. It does not install those model servers and does
not download model weights.

1. Install and run the model server on the machine that owns the model.
2. Download or load the model with that server.
3. Connect it from **Agent > Models**.

See [Local Models](/gateway/local-models), [Ollama](/providers/ollama), and
[LM Studio](/providers/lmstudio).

## Browser control has two optional layers

Fased includes the browser-control interfaces and extension files. Install the
Browser Runtime component for Playwright control and readable-page extraction:

```bash
fased components install browser-runtime
fased gateway restart
```

The component does not install Chrome, Brave, Edge, or Chromium.

Use one of these paths:

- an existing system Chromium browser
- the Fased extension relay
- a separately installed Chromium browser for the managed `fased` profile
- remote CDP or a paired node host when the Gateway runs on a VPS

See [Browser](/tools/browser).

## Local memory embeddings are optional

Native sqlite vector acceleration is bundled but disabled until selected:

```bash
fased components install local-memory-runtime
fased gateway restart
```

`memorySearch.provider = "local"` uses the bundled sqlite vector runtime plus a
separately provisioned `node-llama-cpp` runtime and GGUF embedding model.

Use a source install when you intentionally maintain the native local-embedding
stack. Otherwise choose Ollama or a remote embedding provider. This boundary is
separate from using Ollama or LM Studio as the Agent's chat model.

See [Memory](/concepts/memory).

## Install and update behavior

| Install type                   | Fresh install                                      | Normal `fased update`                                                                            |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Linux/WSL2 Local               | Verified platform-qualified release artifact       | Verified release artifact, checksum and pre-swap checks, atomic activation, then service refresh |
| macOS Local                    | Verified Darwin release artifact and LaunchDaemons | Verified release artifact, checksum and pre-swap checks, atomic activation, then service refresh |
| VPS Hosting                    | Verified Linux x86_64 release artifact             | Verified release artifact, checksum and pre-swap checks, atomic activation, then service refresh |
| Explicit source development    | Source checkout, dependencies, and local build     | Stable Git tag, dependency refresh, and rebuild                                                  |
| Legacy global npm installation | Migration-only compatibility path                  | Transition to the verified managed layout; npm is not lifecycle authority                        |

Fased-owned extensions update only with the signed generation. Independent
third-party extensions are intentionally outside that transaction and must use
their verified, content-addressed extension flow:

```bash
fased plugins status
```

The first supported Linux install downloads both the application layer and a
dependency layer. The installer prints separate timings for release resolution,
download, archive safety checks, extraction, runtime verification, and
activation. Later releases may reuse a dependency layer only when its digest is
already present and the signed release manifest binds that exact digest. The
application and dependency identities still converge as one installed
generation.

The Control UI currently reports update status under **Advanced > Debug >
Update Status**. Run the actual update from the CLI.
