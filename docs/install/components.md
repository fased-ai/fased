---
summary: "What Fased installs in core, what is downloaded later, and what remains external."
read_when:
  - You want to know what a fresh Fased install includes
  - You are adding chat channels, local models, browser control, or local embeddings
  - You need to understand what fased update does with add-ons
title: "Core And Optional Components"
sidebarTitle: "Core And Add-ons"
---

# Core and optional components

Fased keeps the Agent and crypto path in core. Large chat integrations and
machine-specific runtimes are installed only when you choose them.

Inspect the current machine from the CLI:

```bash
fased components
```

The Control UI shows the same lifecycle report under **Services > Components**.
`included`, `installed`, `configured`, and `ready` are separate states. A
configuration field does not mean its runtime is installed or healthy.

## Included in core

A normal install includes:

- Gateway, Control UI, browser Chat, Agents, Tasks, Tools, and provider clients
- Solana wallet controls and the singleton Mining wallet flow
- the bundled `sat-mining` runtime, SAT shared specs, Mining UI, and mining CLI
- Fased Network, offers, requests, trust, bond, and marketplace controls
- browser-control interfaces and the Fased browser extension files
- file-backed memory and remote embedding-provider support

Creating or importing `@wallet:mining` through onboarding attaches the wallet
and enables the bundled `sat-mining` runtime. Do not install a separate mining
package and do not run `fased plugins enable sat-mining` as the normal mining
setup path.

## Official channel add-ons

Telegram, WhatsApp, Discord, Slack, Feishu/Lark, and Google Chat are official
npm add-ons. They are not downloaded by a fresh core install.

The normal browser flow is:

1. Open **Agents > selected Agent > Channels**.
2. Select the channel.
3. Click **Install**.
4. Restart the Gateway when prompted.
5. Return to the channel card and enter its token or complete its login flow.

The onboarding wizard and `fased channels add` offer the same npm download when
you select one of these channels.

CLI installation is also available:

```bash
fased plugins install @fased/telegram
fased plugins install @fased/whatsapp
fased plugins install @fased/discord
fased plugins install @fased/slack
fased plugins install @fased/feishu
fased plugins install @fased/googlechat
fased gateway restart
```

Install only the channels you use. Each add-on carries its own channel runtime
dependencies.

<Note>
The packages above are the official installable channel add-ons in this
release. Other advanced channel extensions may need a source install or their
own channel-specific dependencies until they receive a published add-on
package. Follow the individual channel page instead of assuming the lightweight
hosted runtime downloads every advanced channel dependency.
</Note>

## Optional runtime add-ons

Install these only when the related feature is needed:

```bash
fased components install browser-runtime
fased components install media-runtime
fased components install speech-runtime
fased components install local-memory-runtime
fased gateway restart
```

- **Browser Runtime** adds Playwright control and readable-page extraction.
- **Media Runtime** adds image transforms, file-type detection, and PDF extraction.
- **Speech Runtime** adds the Edge TTS client. OpenAI and ElevenLabs API speech
  do not require this local package.
- **Local Vector Memory** adds native sqlite vector acceleration. File-backed
  memory and remote embedding providers remain in core.

These packages are tracked in the same install ledger as channel add-ons, so
`fased update` can update them after the core update succeeds.

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

Native sqlite vector acceleration is a separate component:

```bash
fased components install local-memory-runtime
fased gateway restart
```

`memorySearch.provider = "local"` uses the native `node-llama-cpp` runtime and a
GGUF embedding model. The lightweight hosted runtime does not include that
native add-on or its model file.

Use a source install when you intentionally maintain the native local-embedding
stack. Otherwise choose Ollama or a remote embedding provider. This boundary is
separate from using Ollama or LM Studio as the Agent's chat model.

See [Memory](/concepts/memory).

## Install and update behavior

| Install type                    | Fresh install                                                       | Normal `fased update`                                                                            |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Linux Local recommended install | Verified Linux release artifact, with npm fallback only when needed | Verified release artifact, checksum and pre-swap checks, atomic activation, then service refresh |
| VPS Hosting install             | Verified Linux release artifact, with npm fallback only when needed | Verified release artifact, checksum and pre-swap checks, atomic activation, then service refresh |
| macOS or source install         | Source checkout, dependencies, and local build                      | Stable Git tag, dependency refresh, and rebuild                                                  |
| Manual global npm install       | npm package-manager install                                         | npm package-manager update unless it uses the managed release-runtime layout                     |

After the core update succeeds, `fased update` checks tracked npm plugins and
updates compatible add-ons. You can review them manually with:

```bash
fased plugins update --all --dry-run
fased plugins update --all
```

The Control UI currently reports update status under **Advanced > Debug >
Update Status**. Run the actual update from the CLI.
