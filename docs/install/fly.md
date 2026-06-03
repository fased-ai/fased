---
title: Fly.io
description: Deploy Fased on Fly.io
summary: "Step-by-step Fly.io deployment for Fased with persistent storage and HTTPS"
read_when:
  - Deploying Fased on Fly.io
  - Setting up Fly volumes, secrets, and first-run config
---

# Fly.io Deployment

**Goal:** Run Fased on a [Fly.io](https://fly.io) machine with persistent storage.

<Warning>
Fly is **not** the default Fased hosting posture. The standard hosted guidance is:
use a normal VPS, join it to Tailscale, and keep operator access private through
the tailnet. If you want that posture, use [Hetzner](/install/hetzner) or
[GCP](/install/gcp) instead.
</Warning>

<Note>
Use Fly only when you intentionally want an internet-facing deployment or a Fly-native edge setup. Do not treat `*.fly.dev` as the default private operator path.
</Note>

## What you need

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account
- Gateway token and any model/channel credentials you plan to add later

## Beginner quick path

1. Clone repo → customize `fly.toml`
2. Create app + volume → set secrets
3. Deploy with `fly deploy`
4. Use `fly proxy` for Control UI
5. Finish setup from the Agent tabs

## 1) Create the Fly app

```bash
# Clone the repo
git clone https://github.com/fased-ai/agent.git fased
cd fased

# Create a new Fly app (pick your own name)
fly apps create my-fased

# Create a persistent volume (1GB is usually enough)
fly volumes create fased_data --size 1 --region iad
```

**Tip:** Choose a region close to you. Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

## 2) Configure fly.toml

Edit `fly.toml` to match your app name and requirements.

**Security note:** The default Fly path exposes a public URL. That is not the standard Fased operator posture. If you need private operator access, prefer a VPS with Tailscale instead of Fly.

```toml
app = "my-fased"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  FASED_PREFER_PNPM = "1"
  FASED_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "fased_data"
  destination = "/data"
```

**Key settings:**

| Setting                     | Why                                                                      |
| --------------------------- | ------------------------------------------------------------------------ |
| `--bind lan`                | Binds to `0.0.0.0` so Fly's proxy can reach the gateway                  |
| `--allow-unconfigured`      | Starts without a config file so the Control UI can write first-run state |
| `internal_port = 3000`      | Must match `--port 3000` (or `FASED_GATEWAY_PORT`) for Fly health checks |
| `memory = "2048mb"`         | 512MB is too small; 2GB recommended                                      |
| `FASED_STATE_DIR = "/data"` | Persists state on the volume                                             |

<Note>
`FASED_STATE_DIR` persists Fased config and credentials. Agent workspace files
are controlled by `agents.defaults.workspace` or each Agent's `workspace`
setting, not by `FASED_STATE_DIR`. For a hosted volume, set the default Agent
workspace to `/data/workspace` during setup or with:

```bash
fly ssh console --command "node dist/index.js config set agents.defaults.workspace /data/workspace"
```

Restart the gateway after changing config.
</Note>

## 3) Set secrets

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set FASED_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Optional model/channel secrets can be added later from the Control UI or as env vars.
# Example:
# fly secrets set OPENAI_API_KEY=sk-...
```

**Notes:**

- Non-loopback binds (`--bind lan`) require `FASED_GATEWAY_TOKEN` for security.
- Treat these tokens like passwords.
- **Prefer env vars over config file** for all API keys and tokens. This keeps secrets out of `fased.json` where they could be accidentally exposed or logged.

## 4) Deploy

```bash
fly deploy
```

First deploy builds the Docker image (~2-3 minutes). Subsequent deploys are faster.

After deployment, verify:

```bash
fly status
fly logs
```

You should see:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
```

## 5) Complete setup in the Control UI

Use a private local proxy instead of treating the public `fly.dev` URL as your
normal operator entrypoint:

```bash
fly proxy 3000:3000 -a my-fased
```

Then open `http://localhost:3000/` and paste your gateway token.
If you open through `fased dashboard` or a tokenized dashboard link, Fased uses
the link once, strips the token from the URL, and stores a Control UI session.

Finish setup from the selected Agent:

- **Agent > Models** for model auth and model roles
- **Chat** for the first working message
- **Agent > Channels** for Discord, Telegram, Slack, WhatsApp, and other routes
- **Agent > Services** for web/search, GitHub, Gmail, and other API connectors

If you did not already set it, point the Agent workspace at the Fly volume
before creating editable skills, files, or memory content:

```bash
fly ssh console --command "node dist/index.js config set agents.defaults.workspace /data/workspace"
```

If you need to edit raw config for debugging, with `FASED_STATE_DIR=/data`, the
config path is `/data/fased.json`.

## 6) Access the Gateway

Use the local `fly proxy` URL for operator access whenever possible. Do not
make the public Fly URL your normal admin surface unless you have separately
reviewed the exposure.

### Logs

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### SSH Console

```bash
fly ssh console
```

## Troubleshooting

### "App is not listening on expected address"

The gateway is binding to `127.0.0.1` instead of `0.0.0.0`.

**Fix:** Add `--bind lan` to your process command in `fly.toml`.

### Health checks failing / connection refused

Fly can't reach the gateway on the configured port.

**Fix:** Ensure `internal_port` matches the gateway port (set `--port 3000` or `FASED_GATEWAY_PORT=3000`).

### OOM / Memory Issues

Container keeps restarting or getting killed. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.

**Fix:** Increase memory in `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Or update an existing machine:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Note:** 512MB is too small. 1GB may work but can OOM under load or with verbose logging. **2GB is recommended.**

### Gateway Lock Issues

Gateway refuses to start with "already running" errors.

This happens when the container restarts but the PID lock file persists on the volume.

**Fix:** Delete the lock file:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

The lock file is at `/data/gateway.*.lock` (not in a subdirectory).

### Config Not Being Read

If using `--allow-unconfigured`, the gateway creates a minimal config. Your custom config at `/data/fased.json` should be read on restart.

Verify the config exists:

```bash
fly ssh console --command "cat /data/fased.json"
```

### Writing Config via SSH

The `fly ssh console -C` command doesn't support shell redirection. To write a config file:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/fased.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/fased.json
```

**Note:** `fly sftp` may fail if the file already exists. Delete first:

```bash
fly ssh console --command "rm /data/fased.json"
```

### State Not Persisting

If you lose credentials or sessions after a restart, the state dir is writing to the container filesystem.

**Fix:** Ensure `FASED_STATE_DIR=/data` is set in `fly.toml` and redeploy.

## Updates

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Updating Machine Command

If you need to change the startup command without a full redeploy:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Note:** After `fly deploy`, the machine command may reset to what's in `fly.toml`. If you made manual changes, re-apply them after deploy.

## Private Deployment (Hardened)

By default, Fly allocates public IPs, making your gateway accessible at `https://your-app.fly.dev`. This is convenient but means your deployment is discoverable by internet scanners.

For a hardened deployment with **no public exposure**, use the repo-backed
private config, `fly.private.toml`.

### When to use private deployment

- You only make **outbound** calls/messages (no inbound webhooks)
- You use a separate private access layer for operator control and do not rely on the public Fly URL for administration
- You access the gateway via **SSH, proxy, or WireGuard** instead of browser
- You want the deployment **hidden from internet scanners**

### Setup

Use `fly.private.toml` instead of the standard config:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Or convert an existing deployment:

```bash
# List current IPs
fly ips list -a my-fased

# Release public IPs
fly ips release <public-ipv4> -a my-fased
fly ips release <public-ipv6> -a my-fased

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with fly.private.toml)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-fased
```

After this, `fly ips list` should show only a `private` type IP:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Accessing a private deployment

Since there's no public URL, use one of these methods:

**Option 1: Local proxy (simplest)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-fased

# Then open http://localhost:3000 in browser
```

**Option 2: WireGuard VPN**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Option 3: SSH only**

```bash
fly ssh console -a my-fased
```

### Webhooks with private deployment

If you need webhook callbacks (Twilio, Telnyx, etc.) without public exposure:

1. **Provider-specific tunnel or relay** - for the webhook path only
2. **Outbound-only** - Some providers work fine without inbound webhooks

Example voice-call config with a separate tunnel provider:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "custom" },
          "webhookSecurity": {
            "allowedHosts": ["example-tunnel-host"]
          }
        }
      }
    }
  }
}
```

Whatever relay or tunnel you use for inbound webhooks, keep it separate from the operator control path. Public webhook ingress is not the same thing as public admin access.

### Exposure differences

| Aspect            | Public Fly URL  | Private Fly path       |
| ----------------- | --------------- | ---------------------- |
| Discovery surface | Public URL/IP   | No public app URL path |
| Gateway exposure  | Internet-facing | Proxy/VPN access path  |
| Control UI access | Browser URL     | Local proxy or VPN     |
| Webhook delivery  | Direct          | Separate relay/tunnel  |

## Notes

- Fly.io uses **x86 architecture** (not ARM)
- The Dockerfile is compatible with both architectures
- For WhatsApp/Telegram onboarding, use `fly ssh console`
- Persistent data lives on the volume at `/data`
- Signal requires Java + signal-cli; use a custom image and keep memory at 2GB+.

## Cost

With the recommended config (`shared-cpu-2x`, 2GB RAM):

- ~$10-15/month depending on usage
- Free tier includes some allowance

See [Fly.io pricing](https://fly.io/docs/about/pricing/) for details.
