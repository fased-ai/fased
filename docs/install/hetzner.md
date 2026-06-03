---
summary: "Run Fased on a Hetzner VPS with durable state and baked-in binaries"
read_when:
  - You want Fased running 24/7 on a cloud VPS (not your laptop)
  - You want an always-on Gateway on your own VPS
  - You want full control over persistence, binaries, and restart behavior
  - You are running Fased in Docker on Hetzner or a similar provider
title: "Hetzner"
---

# Fased on Hetzner (Docker VPS Guide)

## Goal

Run a persistent Fased Gateway on a Hetzner VPS using Docker, with durable state, baked-in binaries, and predictable restart behavior.

Pick a small Debian/Ubuntu VPS and scale up if you hit OOMs. Provider pricing
changes, so check the current plan before provisioning.

Security model reminder:

- Company-shared agents are fine when everyone is in the same trust boundary and the runtime is business-only.
- Keep strict separation: dedicated VPS/runtime + dedicated accounts; no personal Apple/Google/browser/password-manager profiles on that host.
- If users are adversarial to each other, split by gateway/host/OS user.

See [Security](/gateway/security) and [VPS hosting](/install/vps).

## What are we doing (simple terms)?

- Rent a small Linux server (Hetzner VPS)
- Install Docker (isolated app runtime)
- Start the Fased Gateway in Docker
- Persist `~/.fased` + `~/.fased/workspace` on the host (survives restarts/rebuilds)
- Join the VPS to Tailscale before onboarding
- Keep the gateway loopback-only
- Access the Control UI privately from your laptop through Tailscale

The intended operator access path is:

- bootstrap with SSH only long enough to provision the host
- join the VPS to your Tailscale tailnet
- keep the gateway on loopback
- use Tailscale or a private SSH tunnel over Tailscale for ongoing admin access

This guide assumes Ubuntu or Debian on Hetzner.  
If you are on another Linux VPS, map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## Quick path (experienced operators)

1. Provision Hetzner VPS
2. Install Docker
3. Join the VPS to Tailscale
4. Clone the Fased repository
5. Create persistent host directories
6. Configure `.env` and `docker-compose.yml`
7. Bake required binaries into the image
8. `docker compose up -d`
9. Verify persistence and Gateway access

---

## What you need

- Hetzner VPS with initial root access
- SSH access from your laptop
- Basic comfort with SSH + copy/paste
- ~20 minutes
- Docker and Docker Compose
- Model auth credentials
- Optional provider credentials
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1) Provision the VPS

Create an Ubuntu or Debian VPS in Hetzner.

Connect as root for the bootstrap phase:

```bash
ssh root@YOUR_VPS_IP
```

This guide assumes the VPS is stateful.
Do not treat it as disposable infrastructure.

After the host is provisioned and joined to Tailscale, ongoing operator access
should move to **Tailscale/private access**, not normal public root login.

---

## 2) Install Docker (on the VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verify:

```bash
docker --version
docker compose version
```

## 2.5) Join the VPS to Tailscale before onboarding

Create or sign into your Tailscale account first, then join the VPS to your
tailnet before you onboard the runtime.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

From this point forward, treat Tailscale as the normal operator access path.
Do not plan around public gateway exposure.

For a manual VPS, `tailscale up` prints a login URL in SSH. Open that URL in
your local computer's browser, then return to the SSH session. Use a Tailscale
auth key only when you need unattended provisioning, cloud-init, Terraform, or
another non-interactive install path.

---

## 3) Clone the Fased repository

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
```

This guide assumes you will build a custom image so binary persistence is predictable.

---

## 4) Create persistent host directories

Docker containers are ephemeral.
All long-lived state must live on the host.

```bash
mkdir -p /root/.fased/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.fased
```

---

## 5) Configure environment variables

Create `.env` in the repository root.

```bash
FASED_IMAGE=fased:latest
FASED_GATEWAY_TOKEN=change-me-now
FASED_GATEWAY_BIND=loopback
FASED_GATEWAY_PORT=18789

FASED_CONFIG_DIR=/root/.fased
FASED_WORKSPACE_DIR=/root/.fased/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.fased
```

Generate strong secrets:

```bash
openssl rand -hex 32
```

**Do not commit this file.**

---

## 6) Docker Compose configuration

Create or update `docker-compose.yml`.

```yaml
services:
  fased-gateway:
    image: ${FASED_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - FASED_GATEWAY_BIND=${FASED_GATEWAY_BIND}
      - FASED_GATEWAY_PORT=${FASED_GATEWAY_PORT}
      - FASED_GATEWAY_TOKEN=${FASED_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${FASED_CONFIG_DIR}:/home/node/.fased
      - ${FASED_WORKSPACE_DIR}:/home/node/.fased/workspace
    ports:
      # Keep the Gateway loopback-only on the VPS.
      # Access it through Tailscale or a private tunnel; do not expose it publicly by default.
      - "127.0.0.1:${FASED_GATEWAY_PORT}:18789"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${FASED_GATEWAY_BIND}",
        "--port",
        "${FASED_GATEWAY_PORT}",
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured` is only for bootstrap convenience, it is not a replacement for a proper gateway configuration. Still set auth (`gateway.auth.token` or password) and use private bind settings for your deployment.

---

## 7) Bake required binaries into the image (critical)

Installing binaries inside a running container is a trap.
Anything installed at runtime will be lost on restart.

All external binaries required by skills must be installed at image build time.

The examples below show three common binaries only:

- `gog` for Gmail access
- `goplaces` for Google Places
- `wacli` for WhatsApp

These are examples, not a complete list.
You may install as many binaries as needed using the same pattern.

If you add new skills later that depend on additional binaries, you must:

1. Update the Dockerfile
2. Rebuild the image
3. Restart the containers

**Example Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8) Build and launch

```bash
docker compose build
docker compose up -d fased-gateway
```

Verify binaries:

```bash
docker compose exec fased-gateway which gog
docker compose exec fased-gateway which goplaces
docker compose exec fased-gateway which wacli
```

Expected output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Verify Gateway

```bash
docker compose logs -f fased-gateway
```

Success should show the gateway listening internally on port `18789` for the
container, while the host keeps that mapping on `127.0.0.1` only.

From your laptop, prefer a **Tailscale/private** path:

- Tailscale SSH tunnel
- Tailscale Serve on the host
- or another private tailnet path you control

If you use an SSH tunnel, treat that as a private operator tunnel, not a reason
to keep public root login as the steady-state access path.

---

## What persists where (source of truth)

Fased runs in Docker, but Docker is not the source of truth.
All long-lived state must survive restarts, rebuilds, and reboots.

| Component           | Location                       | Persistence mechanism  | Notes                           |
| ------------------- | ------------------------------ | ---------------------- | ------------------------------- |
| Gateway config      | `/home/node/.fased/`           | Host volume mount      | Includes `fased.json`, tokens   |
| Model auth profiles | `/home/node/.fased/`           | Host volume mount      | OAuth tokens, API keys          |
| Skill configs       | `/home/node/.fased/skills/`    | Host volume mount      | Skill-level state               |
| Agent workspace     | `/home/node/.fased/workspace/` | Host volume mount      | Code and agent artifacts        |
| WhatsApp session    | `/home/node/.fased/`           | Host volume mount      | Preserves QR login              |
| Gmail keyring       | `/home/node/.fased/`           | Host volume + password | Requires `GOG_KEYRING_PASSWORD` |
| External binaries   | `/usr/local/bin/`              | Docker image           | Must be baked at build time     |
| Node runtime        | Container filesystem           | Docker image           | Rebuilt every image build       |
| OS packages         | Container filesystem           | Docker image           | Do not install at runtime       |
| Docker container    | Ephemeral                      | Restartable            | Can be destroyed                |

---

## Automation

If you automate this guide with cloud-init, Terraform, Ansible, or another
provisioning tool, keep the same order:

1. create the VPS
2. join Tailscale
3. install Docker and Fased
4. keep the Gateway loopback-only on the host
5. verify private operator access before relying on the runtime
