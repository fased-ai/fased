---
summary: "Supported local Docker setup and onboarding for Fased"
read_when:
  - You want a containerized gateway on your local computer
  - You are validating the Docker flow
title: "Docker"
---

# Local Docker (optional)

Docker is **optional** and the full Docker Gateway is supported only on a local
computer. Fased does not currently support a Docker-hosted Gateway on a VPS or
cloud server, and there is no `install.sh --hosting-docker` mode.

For a maintained VPS deployment, use the non-Docker hosted installer:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --hosting
```

The hosted installer manages the `app` account, Tailscale, firewall and SSH
hardening, systemd service, updates, and rollback. The local Docker setup does
not provide those hosting controls and must not be substituted for it.

## Is Docker right for me?

- **Yes**: you want an isolated Gateway on your own local computer without a
  native Fased installation.
- **No**: you are running on your own machine and want the fastest dev loop. Use
  the normal install flow instead.
- **No for VPS/cloud hosting**: use `install.sh --hosting`; full Docker hosting
  is not a supported deployment path.
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not**
  require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).

This guide covers:

- Containerized Gateway (full Fased in Docker)
- Per-session Agent Sandbox (host gateway + Docker-isolated agent tools)

Sandboxing details: [Sandboxing](/gateway/sandboxing)

## Requirements

- Docker Desktop (or Docker Engine) + Docker Compose v2
- At least 2 GB RAM for image build. On 1 GB hosts, `pnpm install` may be
  OOM-killed with exit 137.
- Enough disk for images + logs

## Containerized Gateway (Docker Compose)

The curl installers and Docker are separate installation paths:

| Goal                                      | Installation path      | Runs in Docker |
| ----------------------------------------- | ---------------------- | -------------- |
| Fased on your computer                    | `install.sh --local`   | No             |
| Fased in Docker on your computer          | This guide             | Yes            |
| Maintained VPS hosting with Tailscale     | `install.sh --hosting` | No             |
| Full Docker Gateway on a VPS/cloud server | Not supported          | —              |

### Build locally from source (recommended now)

Clone the repo, then run from repo root:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
./docker-setup.sh
```

This script:

- builds the local `fased:local` Gateway image
- runs CLI onboarding
- prints dashboard, token, and pairing hints
- starts the gateway via Docker Compose
- generates a gateway token and writes it to `.env`

Optional env vars:

- `FASED_IMAGE` — use a selected image instead of building `fased:local`
- `FASED_DOCKER_APT_PACKAGES` — install extra apt packages during build
- `FASED_EXTRA_MOUNTS` — add extra host bind mounts
- `FASED_HOME_VOLUME` — persist `/home/node` in a named volume

After it finishes:

- Open `http://localhost:18789/` in your browser.
- Paste the token from `.env` or the dashboard link if the browser asks for one.
- In the UI, finish setup from the selected Agent: **Models** first, then **Chat**.
- Need the URL again? Run `docker compose run --rm fased-cli dashboard --no-open`.

It writes config/workspace on the host:

- `~/.fased/`
- `~/.fased/workspace`

### Use a published image after public availability

The official GHCR package remains an owner/testing path until a clean tagged
image passes the Docker security checks and anonymous pulling is enabled. Until
that announcement, public users should use the source-build path above.

After the package is public, select an immutable release tag when possible:

```bash
FASED_IMAGE=ghcr.io/fased-ai/fased:X.Y.Z ./docker-setup.sh
```

`docker-setup.sh` pulls a `FASED_IMAGE` other than `fased:local`, records the
selection in `.env`, runs onboarding, and starts the local Gateway. `latest`
will be available for convenience after public release, but a version tag or
digest is safer when reproducibility matters.

Public GHCR images support anonymous pulls; users do not need a Docker Hub
account, GitHub account, or package token. An `unauthorized` or `denied` error
means the package is not public yet or the requested tag does not exist.

### Local security boundary

The supplied local Compose configuration:

- publishes Gateway and bridge ports on `127.0.0.1` only
- runs as the non-root `node` user
- drops all Linux capabilities and enables `no-new-privileges`
- does not use host networking, privileged mode, or a container-engine socket
- health-checks the running Gateway
- stores the generated `.env` with user-only permissions
- excludes local `.env*`, `.fased`, SSH/private keys, and common credential
  directories from the image build context

Do not change the port mappings to `0.0.0.0`, add `network_mode: host`, mount
`docker.sock`, or enable `privileged`. Those changes cross the supported local
security boundary. Remote access and Docker VPS hosting are not covered by this
guide.

### Manual flow (compose)

```bash
docker build -t fased:local -f Dockerfile .
docker compose run --rm fased-cli onboard
docker compose up -d fased-gateway
```

Note: run `docker compose ...` from the repo root. If you enabled
`FASED_EXTRA_MOUNTS` or `FASED_HOME_VOLUME`, the setup script writes
`docker-compose.extra.yml`; include it when running Compose elsewhere:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI token + pairing (Docker)

If you see “unauthorized” or “disconnected (1008): pairing required”, fetch a
fresh dashboard link and approve the browser device:

```bash
docker compose run --rm fased-cli dashboard --no-open
docker compose run --rm fased-cli devices list
docker compose run --rm fased-cli devices approve <requestId>
```

More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Setup after Docker starts

Use the browser UI for normal setup:

1. open `http://localhost:18789/`
2. choose the default Agent, shown as **Assistant**
3. configure model auth in **Agent > Models**
4. test one message in **Chat**
5. add channels in **Agent > Channels**
6. add API connectors in **Agent > Services**

The CLI onboarding command is still useful for automation, repair, or scripted
container setup, but normal users should not need to edit JSON by hand.

### Extra mounts (optional)

If you want to mount additional host directories into the containers, set
`FASED_EXTRA_MOUNTS` before running `docker-setup.sh`. This accepts a
comma-separated list of Docker bind mounts and applies them to both
`fased-gateway` and `fased-cli` by generating `docker-compose.extra.yml`.

Example:

```bash
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes:

- Paths must be shared with Docker Desktop on macOS/Windows.
- Each entry must be `source:target[:options]` with no spaces, tabs, or newlines.
- Prefer `:ro` unless the container must write to the mounted directory.
- Container-engine sockets such as `docker.sock` are rejected because they
  provide host-level control.
- If you edit `FASED_EXTRA_MOUNTS`, rerun `docker-setup.sh` to regenerate the
  extra compose file.
- `docker-compose.extra.yml` is generated. Don’t hand-edit it.

### Persist the entire container home (optional)

If you want `/home/node` to persist across container recreation, set a named
volume via `FASED_HOME_VOLUME`. This creates a Docker volume and mounts it at
`/home/node`, while keeping the standard config/workspace bind mounts. Use a
named volume here (not a bind path); for bind mounts, use
`FASED_EXTRA_MOUNTS`.

Example:

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

You can combine this with extra mounts:

```bash
export FASED_HOME_VOLUME="fased_home"
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes:

- Named volumes must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- If you change `FASED_HOME_VOLUME`, rerun `docker-setup.sh` to regenerate the
  extra compose file.
- The named volume persists until removed with `docker volume rm <name>`.

### Install extra apt packages (optional)

If you need system packages inside the image (for example, build tools or media
libraries), set `FASED_DOCKER_APT_PACKAGES` before running `docker-setup.sh`.
This installs the packages during the image build, so they persist even if the
container is deleted.

Example:

```bash
export FASED_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notes:

- This accepts a space-separated list of apt package names.
- If you change `FASED_DOCKER_APT_PACKAGES`, rerun `docker-setup.sh` to rebuild
  the image.

### Power-user / full-featured container (opt-in)

The default Docker image is minimal and runs as the non-root `node` user. This
keeps the attack surface small, but it means:

- no system package installs at runtime
- no Homebrew by default
- no bundled Chromium/Playwright browsers

If you want a more full-featured container, use these opt-in knobs:

1. **Persist `/home/node`** so browser downloads and tool caches survive:

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

2. **Bake system deps into the image** (repeatable + persistent):

```bash
export FASED_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Install Playwright browsers without `npx`** (avoids npm override conflicts):

```bash
docker compose run --rm fased-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

If you need Playwright to install system deps, rebuild the image with
`FASED_DOCKER_APT_PACKAGES` instead of using `--with-deps` at runtime.

4. **Persist Playwright browser downloads**:

- Set `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` in
  `docker-compose.yml`.
- Ensure `/home/node` persists via `FASED_HOME_VOLUME`, or mount
  `/home/node/.cache/ms-playwright` via `FASED_EXTRA_MOUNTS`.

### Permissions + EACCES

The image runs as `node` (uid 1000). If you see permission errors on
`/home/node/.fased`, make sure your host bind mounts are owned by uid 1000.

Example (Linux host):

```bash
sudo chown -R 1000:1000 /path/to/fased-config /path/to/fased-workspace
```

If you choose to run as root for convenience, you accept the security tradeoff.

### Faster rebuilds (recommended)

To speed up rebuilds, order your Dockerfile so dependency layers are cached.
This avoids re-running `pnpm install` unless lockfiles change:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Channel setup (optional)

Use **Agent > Channels** in the Control UI for normal setup. It mirrors the
current channel onboarding flow and keeps account credentials separate from
Agent routing.

For scripted Docker setups, you can still run channel CLI commands through the
CLI container, then restart the gateway if that command changed runtime config.

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram),
[Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

If you pick OpenAI Codex OAuth from **Agent > Models**, it opens a browser URL
and tries to capture a callback on `http://127.0.0.1:1455/auth/callback`. In
Docker or headless setups that callback can show a browser error. Copy the full
redirect URL you land on and paste it back into the auth prompt to finish auth.

### Health check

```bash
docker compose exec fased-gateway node dist/index.js health
```

The Compose service already receives `FASED_GATEWAY_TOKEN` from `.env`; the
`health` command reads runtime config/env and does not take a `--token` flag.

### Update local Docker

Do not run `fased update` inside a container. Update the selected image or
source revision, then recreate the Gateway while preserving the same config and
workspace mounts.

For a published image already recorded in `.env`:

```bash
cd /path/to/fased
docker compose pull
docker compose up -d fased-gateway
docker compose exec fased-gateway fased --version
docker compose exec fased-gateway node dist/index.js health
```

For a source-built image, select the intended stable tag, rebuild, and recreate:

```bash
cd /path/to/fased
git fetch origin --tags
git switch --detach vX.Y.Z
docker build --pull -t fased:local -f Dockerfile .
docker compose up -d fased-gateway
docker compose exec fased-gateway fased --version
docker compose exec fased-gateway node dist/index.js health
```

State survives only while `FASED_CONFIG_DIR` and `FASED_WORKSPACE_DIR` keep
pointing to the same host directories or durable volumes.

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Notes

- Gateway bind inside the container is `lan` so Docker port forwarding works;
  the host-side port remains loopback-only.
- Dockerfile CMD uses `--allow-unconfigured`; mounted config with
  `gateway.mode` not `local` will still start. Override CMD to enforce the
  guard.
- The gateway container is the source of truth for sessions (`~/.fased/agents/<agentId>/sessions/`).

## Agent Sandbox (host gateway + Docker tools)

Deep dive: [Sandboxing](/gateway/sandboxing)

This is separate from running the whole Gateway in Docker. The Gateway can run
on the host while selected tool sessions run inside Docker containers.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.fased/sandboxes",
        docker: {
          image: "fased-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "fased-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Key defaults:

- one sandbox per agent by default
- sandbox workspace under `~/.fased/sandboxes`
- Docker network disabled by default
- host browser/camera/canvas are blocked by default
- `deny` tool policy wins over `allow`
- `scope: "shared"` disables cross-session isolation

For full precedence, browser sandboxing, per-agent overrides, and hardening
knobs, use [Sandboxing](/gateway/sandboxing) and
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools).

### Build the default sandbox image

```bash
scripts/sandbox-setup.sh
```

This builds `fased-sandbox:bookworm-slim` using `deploy/containers/Dockerfile.sandbox`.

### Optional sandbox images

If you want a sandbox image with common build tooling (Node, Go, Rust, etc.), build the common image:

```bash
scripts/sandbox-common-setup.sh
```

This builds `fased-sandbox-common:bookworm-slim`. To use it:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "fased-sandbox-common:bookworm-slim" } },
    },
  },
}
```

To run the browser tool inside the sandbox, build the browser image:

```bash
scripts/sandbox-browser-setup.sh
```

### Custom sandbox image

Build your own image and point config to it:

```bash
docker build -t my-fased-sbx -f deploy/containers/Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-fased-sbx" } },
    },
  },
}
```

### Isolation notes

- Hard wall only applies to **tools** (exec/read/write/edit/apply_patch).
- Host-only tools like browser/camera/canvas are blocked by default.
- Allowing `browser` in sandbox **breaks isolation** (browser runs on host).

## Troubleshooting

- Image missing: build with
  [`scripts/sandbox-setup.sh`](https://github.com/fased-ai/fased/blob/main/scripts/sandbox-setup.sh)
  or set `agents.defaults.sandbox.docker.image`.
- Container not running: it will auto-create per session on demand.
- Permission errors in sandbox: set `docker.user` to a UID:GID that matches your
  mounted workspace ownership (or chown the workspace folder).
- Custom tools not found: Fased runs commands with `sh -lc` (login shell), which
  sources `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your
  custom tool paths (e.g., `/custom/bin:/usr/local/share/npm-global/bin`), or add
  a script under `/etc/profile.d/` in your Dockerfile.
