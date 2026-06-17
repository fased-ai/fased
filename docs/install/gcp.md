---
summary: "Run Fased on a GCP Compute Engine VM with durable state"
read_when:
  - You want Fased running 24/7 on GCP
  - You want an always-on Gateway on your own VM
  - You want full control over persistence, binaries, and restart behavior
title: "GCP"
---

# Fased on GCP Compute Engine (Docker VPS Guide)

## Goal

Run a persistent Fased Gateway on a GCP Compute Engine VM using Docker, with
durable state, baked-in binaries, and predictable restart behavior.

Pricing varies by machine type and region. Pick the smallest VM that fits your
workload and scale up if you hit OOMs.

## What are we doing (simple terms)?

- Create a GCP project and enable billing
- Create a Compute Engine VM
- Install Docker (isolated app runtime)
- Start the Fased Gateway in Docker
- Persist `~/.fased` + `~/.fased/workspace` on the host so state survives
  restarts and rebuilds
- Join the VM to Tailscale before onboarding
- Keep operator access private through Tailscale

The intended operator access path is:

- bootstrap with `gcloud compute ssh` only long enough to provision the host
- join the VM to your Tailscale tailnet
- keep the gateway loopback-only on the VM
- use Tailscale or a private tunnel over Tailscale for ongoing admin access

This guide uses Debian on GCP Compute Engine.
Ubuntu also works; map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## Quick path (experienced operators)

1. Create GCP project + enable Compute Engine API
2. Create Compute Engine VM (e2-small, Debian 12, 20GB)
3. Bootstrap into the VM with SSH
4. Install Docker
5. Join Tailscale, then clone the Fased repository
6. Create persistent host directories
7. Configure `.env` and `docker-compose.yml`
8. Bake required binaries, build, and launch

---

## What you need

- GCP account (free tier eligible for e2-micro)
- gcloud CLI installed (or use Cloud Console)
- SSH access from your laptop for bootstrap
- Basic comfort with SSH + copy/paste
- ~20-30 minutes
- Docker and Docker Compose
- Model auth credentials
- Optional provider credentials
  - WhatsApp QR
  - Telegram agent token
  - Gmail OAuth

---

## 1) Install gcloud CLI (or use Console)

**Option A: gcloud CLI** (recommended for automation)

Install from [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initialize and authenticate:

```bash
gcloud init
gcloud auth login
```

**Option B: Cloud Console**

All steps can be done via the web UI at [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2) Create a GCP project

**CLI:**

```bash
gcloud projects create my-fased-project --name="Fased Gateway"
gcloud config set project my-fased-project
```

Enable billing at
[https://console.cloud.google.com/billing](https://console.cloud.google.com/billing).
Compute Engine requires billing.

Enable the Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Go to IAM & Admin > Create Project
2. Name it and create
3. Enable billing for the project
4. Navigate to APIs & Services > Enable APIs > search "Compute Engine API" > Enable

---

## 3) Create the VM

**Machine types:**

| Type      | Specs                    | Cost               | Notes                                        |
| --------- | ------------------------ | ------------------ | -------------------------------------------- |
| e2-medium | 2 vCPU, 4GB RAM          | ~$25/mo            | Most reliable for local Docker builds        |
| e2-small  | 2 vCPU, 2GB RAM          | ~$12/mo            | Minimum recommended for Docker build         |
| e2-micro  | 2 vCPU (shared), 1GB RAM | Free tier eligible | Often fails with Docker build OOM (exit 137) |

**CLI:**

```bash
gcloud compute instances create fased-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Go to Compute Engine > VM instances > Create instance
2. Name: `fased-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4) SSH into the VM

**CLI:**

```bash
gcloud compute ssh fased-gateway --zone=us-central1-a
```

**Console:**

Click the "SSH" button next to your VM in the Compute Engine dashboard.

Note: SSH key propagation can take 1-2 minutes after VM creation. If connection is refused, wait and retry.

---

## 5) Install Docker (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in for the group change to take effect:

```bash
exit
```

Then SSH back in:

```bash
gcloud compute ssh fased-gateway --zone=us-central1-a
```

Verify:

```bash
docker --version
docker compose version
```

---

## 5.5) Join the VM to Tailscale before onboarding

Create or sign into your Tailscale account first, then join the VM to your
tailnet before you continue with the runtime setup.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

From this point forward, treat Tailscale as the normal operator access path.
Do not plan around public gateway exposure.

For a manual VM, `sudo tailscale up` prints a login URL in SSH. Open that URL in
your local computer's browser, then return to the SSH session. Use a Tailscale
auth key only when you need unattended provisioning, cloud-init, Terraform, or
another non-interactive install path.

---

## 6) Clone the Fased repository

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
```

This guide assumes you will build a custom image so binary persistence is predictable.

---

## 7) Create persistent host directories

Docker containers are ephemeral.
All long-lived state must live on the host.

```bash
mkdir -p ~/.fased
mkdir -p ~/.fased/workspace
```

---

## 8) Configure environment variables

Create `.env` in the repository root.

```bash
FASED_IMAGE=fased:latest
FASED_GATEWAY_TOKEN=change-me-now
FASED_GATEWAY_BIND=lan
FASED_GATEWAY_PORT=18789

FASED_CONFIG_DIR=/home/$USER/.fased
FASED_WORKSPACE_DIR=/home/$USER/.fased/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.fased
```

Generate strong secrets:

```bash
openssl rand -hex 32
```

**Do not commit this file.**

---

## 9) Docker Compose configuration

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
      # Keep the Gateway loopback-only on the VM.
      # Ongoing operator access should stay private through Tailscale.
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
      ]
```

---

## 10) Bake required binaries into the image (critical)

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

## 11) Build and launch

```bash
docker compose build
docker compose up -d fased-gateway
```

If build fails with `Killed` / `exit code 137` during
`pnpm install --frozen-lockfile`, the VM is out of memory. Use `e2-small`
minimum, or `e2-medium` for more reliable first builds.

The container binds on LAN internally while the host port stays on `127.0.0.1`.
If the Control UI rejects the local origin, set an explicit allowed origin:

```bash
docker compose exec fased-gateway \
  node dist/index.js config set gateway.controlUi.allowedOrigins '["http://localhost:18789"]' --strict-json
```

If you changed the gateway port, replace `18789` with your configured port.

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

## 12) Verify Gateway

```bash
docker compose logs -f fased-gateway
```

Success should show the gateway listening inside the container:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) Access from your laptop

Use a private tailnet path from your laptop:

- Tailscale Serve on the VM
- an SSH tunnel carried over Tailscale
- another private tailnet path you control

Keep the public VM IP and raw gateway port out of the normal operator access
path.

Fetch a fresh tokenized dashboard link:

```bash
docker compose run --rm fased-cli dashboard --no-open
```

Paste the token from that URL.

If Control UI shows `unauthorized` or `disconnected (1008): pairing required`, approve the browser device:

```bash
docker compose run --rm fased-cli devices list
docker compose run --rm fased-cli devices approve <requestId>
```

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

## Updates

To update Fased on the VM:

```bash
cd ~/fased
git pull
docker compose build
docker compose up -d
```

---

## Troubleshooting

**SSH connection refused**

SSH key propagation can take 1-2 minutes after VM creation. Wait and retry.

**OS Login issues**

Check your OS Login profile:

```bash
gcloud compute os-login describe-profile
```

Ensure your account has the required IAM permissions: Compute OS Login or
Compute OS Admin Login.

**Out of memory (OOM)**

If Docker build fails with `Killed` and `exit code 137`, the VM was OOM-killed.
Upgrade to `e2-small` minimum or `e2-medium` for reliable local builds:

```bash
# Stop the VM first
gcloud compute instances stop fased-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type fased-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start fased-gateway --zone=us-central1-a
```

---

## Service accounts

For personal use, your default user account works fine.

For automation or CI/CD pipelines, create a dedicated service account with
minimal permissions:

1. Create a service account:

   ```bash
   gcloud iam service-accounts create fased-deploy \
     --display-name="Fased Deployment"
   ```

2. Grant Compute Instance Admin role (or narrower custom role):

   ```bash
   gcloud projects add-iam-policy-binding my-fased-project \
     --member="serviceAccount:fased-deploy@my-fased-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Avoid using the Owner role for automation. Use the principle of least privilege.

See
[https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)
for IAM role details.

---

## Next steps

- Configure model auth in **Agent > Models**, then send a first message in **Chat**
- Set up messaging channels in **Agent > Channels**
- Connect API services in **Agent > Services**
- Pair local devices in **Advanced > Nodes**: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
