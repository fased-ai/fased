---
summary: "Testing kit: unit/e2e/live suites plus wallet, mining, and Fased Network regression coverage."
read_when:
  - Running tests locally or in CI
  - Adding regressions for model/provider bugs
  - Debugging gateway + agent behavior
title: "Testing"
---

# Testing

Fased has three Vitest suites: unit/integration, e2e, and live. It also has a
small set of Docker runners.

This doc is a “how we test” guide:

- What each suite covers (and what it deliberately does _not_ cover)
- Which commands to run for common workflows (local, pre-push, debugging)
- How live tests discover credentials and select models/providers
- How to add regressions for real-world model/provider issues

## Quick start

Most days:

- Full gate (expected before push): `pnpm build && pnpm check && pnpm test`
- Docs-only gate: `pnpm check:docs`

When you touch tests or want extra confidence:

- Coverage gate: `pnpm test:coverage`
- E2E suite: `pnpm test:e2e`

When debugging real providers/models (requires real creds):

- Live suite (models + gateway tool/image probes): `pnpm test:live`

Tip: when you only need one failing case, narrow live tests with the allowlist
env vars described below.

When a browser/runtime issue is not a test failure yet, collect operator
evidence first:

- **Logs** for the runtime error stream.
- **Usage** for token/provider/model accounting.
- **Advanced > Debug** for raw status snapshots and plugin/runtime diagnostics.
- **Advanced > Nodes** for paired device/runtime failures.

Then add the smallest regression that covers the broken path.

## Test suites (what runs where)

Think of the suites as “increasing realism” (and increasing flakiness/cost):

### Unit / integration (default)

- Command: `pnpm test`
- Config: `scripts/test-parallel.mjs`
- Runs: `vitest.unit.config.ts`, `vitest.extensions.config.ts`,
  `vitest.gateway.config.ts`
- Files: `src/**/*.test.ts`, `extensions/**/*.test.ts`
- Scope:
  - Pure unit tests
  - In-process integration tests (gateway auth, routing, tooling, parsing, config)
  - Deterministic regressions for known bugs
- Expectations:
  - Runs in CI
  - No real keys required
  - Should be fast and stable
- Pool note:
  - Fased uses Vitest `vmForks` on Node 22/23 for faster unit shards.
  - On Node 24+, Fased automatically falls back to regular `forks` to avoid
    Node VM linking errors: `ERR_VM_MODULE_LINK_FAILURE` or
    `module is already linked`.
  - Override manually with `FASED_TEST_VM_FORKS=0` to force `forks`, or
    `FASED_TEST_VM_FORKS=1` to force `vmForks`.

### E2E (gateway smoke)

- Command: `pnpm test:e2e`
- Config: `vitest.e2e.config.ts`
- Files: `src/**/*.e2e.test.ts`
- Runtime defaults:
  - Uses Vitest `vmForks` for faster file startup.
  - Uses adaptive workers (CI: 2-4, local: 4-8).
  - Runs in silent mode by default to reduce console I/O overhead.
- Useful overrides:
  - `FASED_E2E_WORKERS=<n>` to force worker count (capped at 16).
  - `FASED_E2E_VERBOSE=1` to re-enable verbose console output.
- Scope:
  - Multi-instance gateway end-to-end behavior
  - WebSocket/HTTP surfaces, node pairing, and heavier networking
- Expectations:
  - Runs in CI (when enabled in the pipeline)
  - No real keys required
  - More moving parts than unit tests (can be slower)

### Live (real providers + real models)

- Command: `pnpm test:live`
- Config: `vitest.live.config.ts`
- Files: `src/**/*.live.test.ts`
- Default: **enabled** by `pnpm test:live` (sets `FASED_LIVE_TEST=1`)
- Scope:
  - “Does this provider/model actually work _today_ with real creds?”
  - Catch provider format changes, tool-calling quirks, auth issues, and rate
    limit behavior
- Expectations:
  - Not CI-stable by design (real networks, real provider policies, quotas, outages)
  - Costs money / uses rate limits
  - Prefer narrowed subsets instead of everything
  - Live runs will source `~/.profile` to pick up missing API keys
- API key rotation is provider-specific. Set `*_API_KEYS` with comma/semicolon
  format, or use numbered vars such as `*_API_KEY_1`, `*_API_KEY_2`.
- Examples: `OPENAI_API_KEYS`, `ANTHROPIC_API_KEYS`, `GEMINI_API_KEYS`.
- For live-only overrides, use `FASED_LIVE_*_KEY`. Tests retry on rate limit
  responses.

## Which suite should I run?

Use this decision table:

- Editing logic/tests: run `pnpm test`, and `pnpm test:coverage` if you changed
  a lot.
- Touching gateway networking / WS protocol / pairing: add `pnpm test:e2e`
- Debugging provider-specific failures or tool calling: run a narrowed
  `pnpm test:live`.
- Debugging UI-only state mismatch: reproduce in the focused page first, then
  add or update the matching UI/controller test.

## Wallet, mining, and Fased Network regressions

If you touch the operator stack, do not stop at generic unit tests.

The minimum useful split is:

- wallet and SAT UI rendering
- wallet and SAT UI controllers
- signer, passkey, mining, and Fased Network backend paths

### Fast UI confidence

Run the main browser-surface regressions:

```bash
pnpm exec vitest run \
  ui/src/ui/views/wallet.test.ts \
  ui/src/ui/views/mining.test.ts \
  ui/src/ui/views/federation.test.ts
```

### Controller and interaction confidence

Run the focused interaction tests:

```bash
pnpm exec vitest run \
  ui/src/ui/controllers/wallet.test.ts \
  ui/src/ui/controllers/mining.test.ts \
  ui/src/ui/wallet-passkey.test.ts \
  ui/src/ui/mining-commit.test.ts
```

### Runtime and gateway confidence

Run the backend regressions that cover signer health, SAT HTTP flows, passkey
approval auth, and Fased Network attach logic:

```bash
pnpm exec vitest run \
  src/commands/wallet.signer-doctor.test.ts \
  src/gateway/server.wallet-approval-auth-http.test.ts \
  src/gateway/server.sat-mining-http.test.ts \
  src/federation/auto-connect.test.ts
```

Practical rule:

- changing Wallet docs or labels usually needs the Wallet and passkey UI tests
- changing Mining math, capital, commit, or readiness needs Mining UI plus SAT
  HTTP tests
- changing Fased Network bond or route logic needs Fased Network UI plus
  `src/federation/auto-connect.test.ts`

## Live: Android node capability sweep

- Test: `src/gateway/android-node.capabilities.live.test.ts`
- Script: `pnpm android:test:integration`
- Goal: invoke **every command currently advertised** by a connected Android
  node and assert command contract behavior.
- Scope:
  - Preconditioned/manual setup (the suite does not install/run/pair the app).
  - Command-by-command gateway `node.invoke` validation for the selected Android
    node.
- Required pre-setup:
  - Android app already connected + paired to the gateway.
  - App kept in foreground.
  - Permissions/capture consent granted for capabilities you expect to pass.
- Optional target overrides:
  - `FASED_ANDROID_NODE_ID` or `FASED_ANDROID_NODE_NAME`.
  - `FASED_ANDROID_GATEWAY_URL`
  - `FASED_ANDROID_GATEWAY_TOKEN`
  - `FASED_ANDROID_GATEWAY_PASSWORD`
- Full Android setup details: [Android App](/platforms/android)

## Live: model smoke (profile keys)

Live tests are split into two layers so we can isolate failures:

- "Direct model" tells us the provider/model can answer at all with the given
  key.
- "Gateway smoke" tells us the full gateway+agent pipeline works for that model:
  sessions, history, tools, sandbox policy, and related runtime wiring.

### Layer 1: Direct model completion (no gateway)

- Test: `src/agents/models.profiles.live.test.ts`
- Goal:
  - Enumerate discovered models
  - Use `getApiKeyForModel` to select models you have creds for
  - Run a small completion per model (and targeted regressions where needed)
- How to enable:
  - `pnpm test:live` (or `FASED_LIVE_TEST=1` if invoking Vitest directly)
- Set `FASED_LIVE_MODELS=modern` to run this suite. `all` is an alias for
  `modern`. Otherwise it skips so `pnpm test:live` stays focused on gateway
  smoke.
- How to select models:
  - `FASED_LIVE_MODELS=modern` to run the current modern allowlist from code.
  - `FASED_LIVE_MODELS=all` is an alias for the modern allowlist
  - or `FASED_LIVE_MODELS="<provider/model>,<provider/model>"` (comma allowlist)
- How to select providers:
  - `FASED_LIVE_PROVIDERS="google,google-gemini-cli"` (comma allowlist)
- Where keys come from:
  - By default: profile store and env fallbacks
  - Set `FASED_LIVE_REQUIRE_PROFILE_KEYS=1` to enforce **profile store** only
- Why this exists:
  - Separates "provider API is broken / key is invalid" from "gateway agent
    pipeline is broken"
  - Contains small, isolated regressions, such as OpenAI Responses/Codex
    Responses reasoning replay plus tool-call flows

### Layer 2: Gateway + dev agent smoke (what “@fased” actually does)

- Test: `src/gateway/gateway-models.profiles.live.test.ts`
- Goal:
  - Spin up an in-process gateway
  - Create/patch a `agent:dev:*` session (model override per run)
  - Iterate models-with-keys and assert:
    - “meaningful” response (no tools)
    - a real tool invocation works (read probe)
    - optional extra tool probes (exec+read probe)
    - OpenAI regression paths (tool-call-only → follow-up) keep working
- Probe details:
  - `read` probe: writes a nonce file in the workspace, asks the agent to
    `read` it, and expects the nonce back.
  - `exec+read` probe: asks the agent to `exec`-write a nonce into a temp file,
    then `read` it back.
  - image probe: attaches a generated PNG with a randomized code and expects the
    model to return that code.
  - Implementation reference: `src/gateway/gateway-models.profiles.live.test.ts`
    and `src/gateway/live-image-probe.ts`.
- How to enable:
  - `pnpm test:live` (or `FASED_LIVE_TEST=1` if invoking Vitest directly)
- How to select models:
  - Default: current modern allowlist from code.
  - `FASED_LIVE_GATEWAY_MODELS=all` is an alias for the modern allowlist
  - Or set `FASED_LIVE_GATEWAY_MODELS="provider/model"` or a comma list to narrow
- How to select providers (avoid “OpenRouter everything”):
  - `FASED_LIVE_GATEWAY_PROVIDERS="google,google-gemini-cli,openai,anthropic,zai,minimax"`
- Tool + image probes are always on in this live test:
  - `read` probe + `exec+read` probe (tool stress)
  - image probe runs when the model advertises image input support
  - Flow (high level):
    - Test generates a tiny PNG with a random code
      (`src/gateway/live-image-probe.ts`)
    - Sends it via `agent` attachments
    - Gateway parses attachments into `images[]`
      (`src/gateway/server-methods/agent.ts` +
      `src/gateway/chat-attachments.ts`)
    - Embedded agent forwards a multimodal user message to the model
    - Assertion: reply contains the code. Minor OCR mistakes are tolerated.

Tip: to see what you can test on your machine, including exact
`provider/model` ids, run:

```bash
fased models list
fased models list --json
```

## Live: Anthropic setup-token smoke

- Test: `src/agents/anthropic.setup-token.live.test.ts`
- Goal: verify Claude Code CLI setup-token or a pasted setup-token profile can
  complete an Anthropic prompt.
- Enable:
  - `pnpm test:live` (or `FASED_LIVE_TEST=1` if invoking Vitest directly)
  - `FASED_LIVE_SETUP_TOKEN=1`
- Token sources (pick one):
  - Profile: `FASED_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - Raw token: `FASED_LIVE_SETUP_TOKEN_VALUE=<setup-token>`
- Model override (optional):
  - `FASED_LIVE_SETUP_TOKEN_MODEL=<provider/model>`

Setup example:

```bash
fased models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
FASED_LIVE_SETUP_TOKEN=1 \
  FASED_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test \
  pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## Live: CLI backend smoke (Claude Code CLI or other local CLIs)

- Test: `src/gateway/gateway-cli-backend.live.test.ts`
- Goal: validate the Gateway + agent pipeline using a local CLI backend without
  touching your default config.
- Enable:
  - `pnpm test:live` (or `FASED_LIVE_TEST=1` if invoking Vitest directly)
  - `FASED_LIVE_CLI_BACKEND=1`
- Defaults:
  - Model: the CLI backend default from code.
  - Command: `claude`
  - Args: `["-p","--output-format","json","--dangerously-skip-permissions"]`
- Overrides (optional):
  - `FASED_LIVE_CLI_BACKEND_MODEL="<provider/model>"`
  - `FASED_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `FASED_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `FASED_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `FASED_LIVE_CLI_BACKEND_IMAGE_PROBE=1` to send a real image attachment.
  - `FASED_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` to pass image file paths as
    CLI args.
  - `FASED_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"` or `"list"` to control image
    arg passing.
  - `FASED_LIVE_CLI_BACKEND_RESUME_PROBE=1` to send a second turn and validate
    resume flow.
- `FASED_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` keeps Claude Code CLI MCP config
  enabled. Default disables MCP config with a temporary empty file.

Example:

```bash
FASED_LIVE_CLI_BACKEND=1 \
  FASED_LIVE_CLI_BACKEND_MODEL="<provider/model>" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### Recommended live recipes

Narrow, explicit allowlists are fastest and least flaky:

- Single model, direct (no gateway):

  ```bash
  FASED_LIVE_MODELS="<provider/model>" \
    pnpm test:live src/agents/models.profiles.live.test.ts
  ```

- Single model, gateway smoke:

  ```bash
  FASED_LIVE_GATEWAY_MODELS="<provider/model>" \
    pnpm test:live src/gateway/gateway-models.profiles.live.test.ts
  ```

- Tool calling across several providers you actively support:

  ```bash
  FASED_LIVE_GATEWAY_MODELS="<provider/model>,<provider/model>" \
    pnpm test:live src/gateway/gateway-models.profiles.live.test.ts
  ```

- Google focus (Gemini API key + Gemini CLI):

  ```bash
  FASED_LIVE_GATEWAY_MODELS="google/<model>" \
    pnpm test:live src/gateway/gateway-models.profiles.live.test.ts

  FASED_LIVE_GATEWAY_MODELS="google-gemini-cli/<model>" \
    pnpm test:live src/gateway/gateway-models.profiles.live.test.ts
  ```

Notes:

- `google/...` uses the Gemini API (API key).
- `google-gemini-cli/...` uses the local Gemini CLI on your machine, with
  separate auth and tooling quirks.
- Gemini API vs Gemini CLI:
  - API: Fased calls Google's hosted Gemini API over HTTP with API key/profile
    auth. This is what most users mean by "Gemini".
  - CLI: Fased shells out to a local `gemini` binary. It has its own auth and
    can behave differently, including streaming/tool support/version skew.

## Live: model matrix

There is no fixed public model list in this doc. Live tests should follow what
the local provider registry and credentials support on the machine running the
suite.

Use:

```bash
fased models list
fased models scan
```

Pick a small matrix that covers:

- at least one direct hosted model path;
- at least one Gateway + Agent smoke path;
- one model with tool calling;
- one image-capable model if the change touches attachments or vision;
- any custom/OpenAI-compatible endpoint you depend on.

Keep exact `provider/model` allowlists in local runbooks or CI variables, not in
this help page.

## Credentials (never commit)

Live tests discover credentials the same way the CLI does. Practical implications:

- If the CLI works, live tests should find the same keys.
- If a live test says "no creds", debug it the same way you would debug
  `fased models list` and model selection.

- Profile store: `~/.fased/credentials/` (preferred; what "profile keys" means
  in the tests)
- Config: `~/.fased/fased.json` (or `FASED_CONFIG_PATH`)

If you rely on env keys exported in `~/.profile`, run local tests after
`source ~/.profile`. You can also use the Docker runners below; they can mount
`~/.profile` into the container.

## Deepgram live (audio transcription)

- Test: `src/media-understanding/providers/deepgram/audio.live.test.ts`
- Enable:

  ```bash
  DEEPGRAM_API_KEY=... \
    DEEPGRAM_LIVE_TEST=1 \
    pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts
  ```

## BytePlus coding plan live

- Test: `src/agents/byteplus.live.test.ts`
- Enable:

  ```bash
  BYTEPLUS_API_KEY=... \
    BYTEPLUS_LIVE_TEST=1 \
    pnpm test:live src/agents/byteplus.live.test.ts
  ```

- Optional model override: `BYTEPLUS_CODING_MODEL=<model-id>`

## Docker runners (optional “works in Linux” checks)

These run `pnpm test:live` inside the repo Docker image, mounting your local
config dir and workspace. They source `~/.profile` if mounted.

- Direct models: `pnpm test:docker:live-models` (script: `scripts/test-live-models-docker.sh`)
- Gateway + dev agent: `pnpm test:docker:live-gateway` (script: `scripts/test-live-gateway-models-docker.sh`)
- Onboarding wizard (TTY, full scaffolding): `pnpm test:docker:onboard` (script: `scripts/e2e/onboard-docker.sh`)
- Gateway networking: `pnpm test:docker:gateway-network`
  - two containers, WS auth + health
  - script: `scripts/e2e/gateway-network-docker.sh`
- Plugins (custom extension load + registry smoke): `pnpm test:docker:plugins` (script: `scripts/e2e/plugins-docker.sh`)

Manual ACP plain-language thread smoke (not CI):

- `bun scripts/dev/discord-acp-plain-language-smoke.ts --channel <discord-channel-id> ...`
- Keep this script for regression/debug workflows. It may be needed again for
  ACP thread routing validation.

Useful env vars:

- `FASED_CONFIG_DIR=...` (default: `~/.fased`) mounted to `/home/node/.fased`
- `FASED_WORKSPACE_DIR=...` (default: `~/.fased/workspace`) mounted to `/home/node/.fased/workspace`
- `FASED_PROFILE_FILE=...` (default: `~/.profile`) mounted to `/home/node/.profile` and sourced before running tests
- `FASED_LIVE_GATEWAY_MODELS=...` / `FASED_LIVE_MODELS=...` to narrow the run
- `FASED_LIVE_REQUIRE_PROFILE_KEYS=1` to ensure creds come from the profile store (not env)

## Docs sanity

Run docs checks after doc edits:

```bash
pnpm check:docs
pnpm docs:list
```

## Offline regression (CI-safe)

These are “real pipeline” regressions without real providers:

- Gateway tool calling: `src/gateway/gateway.test.ts`
  - mock OpenAI, real gateway + agent loop
  - case: "runs a mock OpenAI tool call end-to-end via gateway agent loop"
- Gateway wizard: `src/gateway/gateway.test.ts`
  - WS `wizard.start`/`wizard.next`, writes config + auth enforced
  - case: "runs wizard over ws and writes auth token config"

## Agent reliability evals (skills)

We already have a few CI-safe tests that behave like “agent reliability evals”:

- Mock tool-calling through the real gateway + agent loop (`src/gateway/gateway.test.ts`).
- End-to-end wizard flows that validate session wiring and config effects (`src/gateway/gateway.test.ts`).

What’s still missing for skills (see [Skills](/tools/skills)):

- **Decisioning:** when skills are listed in the prompt, does the agent pick the right skill (or avoid irrelevant ones)?
- **Compliance:** does the agent read `SKILL.md` before use and follow required steps/args?
- **Workflow contracts:** multi-turn scenarios that assert tool order, session
  history carryover, and sandbox boundaries.

Future evals should stay deterministic first:

- A scenario runner using mock providers to assert tool calls + order, skill file
  reads, and session wiring.
- A small suite of skill-focused scenarios (use vs avoid, gating, prompt injection).
- Optional live evals (opt-in, env-gated) only after the CI-safe suite is in place.

## Adding regressions (guidance)

When you fix a provider/model issue discovered in live:

- Add a CI-safe regression if possible: mock/stub provider, or capture the exact
  request-shape transformation.
- If it is inherently live-only, such as rate limits or auth policies, keep the
  live test narrow and opt-in via env vars.
- Prefer targeting the smallest layer that catches the bug:
  - provider request conversion/replay bug → direct models test
  - gateway session/history/tool pipeline bug → gateway live smoke or CI-safe gateway mock test
