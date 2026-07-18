---
summary: "Fased on DigitalOcean (simple VPS path)"
read_when:
  - Setting up Fased on DigitalOcean
  - Looking for a simple VPS path for Fased
title: "DigitalOcean"
---

# Fased on DigitalOcean

## Goal

Run a persistent Fased Gateway on a small DigitalOcean Ubuntu droplet.

If you prefer a provider-specific ARM path, see the [Oracle Cloud guide](/platforms/oracle).

## Provider fit

DigitalOcean is a straightforward Ubuntu VPS path. Other VPS providers work too
when they give you a clean Ubuntu host, SSH access, outbound internet, and enough
memory for Node plus the Gateway. Check current provider pricing and limits
before creating the server.

---

## Prerequisites

- DigitalOcean account
- SSH key pair
- Tailscale account for private remote access
- ~20 minutes

## 1) Create a Droplet

<Warning>
Use a clean base image (Ubuntu 24.04 LTS). Avoid prebuilt app images unless you
have reviewed their startup scripts and firewall defaults.
</Warning>

1. Log into [DigitalOcean](https://cloud.digitalocean.com/)
2. Click **Create → Droplets**
3. Choose:
   - **Region:** Closest to you (or your users)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic Ubuntu droplet with at least 1GB RAM
   - **Authentication:** SSH key
4. Click **Create Droplet**
5. Note the IP address

## 2) Connect via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) Install Fased with the hosting profile

For hosted deployments, run the standard hosting installer on the VPS itself.
It installs missing tools, starts Tailscale when needed, prints the Tailscale
login URL, and applies the hosted profile.

Run the [one-command Hosting installer](/install/vps) from the provider's root
console. It verifies the tagged Hosting release before privileged Fased
installation. Do not run an app-owned checkout with sudo.

The hosting installer runs onboarding and walks you through:

- Host profile, workspace, Gateway bind/auth, and hosting security
- Gateway token generation
- Optional wallet/mining setup if you choose those paths
- Daemon installation (systemd)
- Tailscale-only dashboard and SSH access

After the Gateway is online, finish product setup in the Control UI from the
selected Agent: **Agent > Models**, **Agent > Channels**, **Agent > Services**,
**Agent > Skills**, **Agent > Memory**, and **Agent > Tasks**.

## 4) Verify the Gateway

Leave the root bootstrap shell and reconnect over Tailscale as the application
account. Replace the host below with the Droplet's MagicDNS name or `100.x`
Tailscale address:

```bash
exit
ssh app@YOUR_DROPLET_TAILSCALE_NAME
fased health
fased status
fased wallet signer doctor --json
```

The `app` account intentionally has no sudo access. For root-owned systemd
status or journals, use the DigitalOcean console as the host administrator;
never add an `app` sudo rule to reach the signer or updater.

## 5) Access the Control UI

The hosting path keeps the raw Gateway port private. To access the Control UI:

**Option A: Tailscale dashboard link**

Run this on the droplet and open the printed private URL from a device on your
tailnet:

```bash
fased dashboard
```

**Option B: SSH Tunnel**

```bash
# From your local machine
ssh -L 18789:localhost:18789 app@YOUR_DROPLET_TAILSCALE_NAME

# Then open: http://localhost:18789
```

**Option C: Tailscale Serve (HTTPS, loopback-only)**

```bash
# Configure Gateway to use Tailscale Serve
fased config set gateway.tailscale.mode serve
fased gateway restart
```

Open: `https://<magicdns>/`

Notes:

- Serve keeps the Gateway loopback-only and authenticates Control UI/WebSocket
  traffic through Tailscale headers.
- Tokenless browser auth assumes a trusted gateway host. HTTP APIs still require
  token/password.
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.

**Option D: Tailnet bind (no Serve)**

```bash
fased config set gateway.bind tailnet
fased gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

Once open, use **Dashboard** for overview, **Chat** to test the Agent,
**Agents** for models, channels, skills, tools, memory, services, and tasks, and
**Advanced** for Config, Debug, and Nodes.

## 7) Connect channels

Use **Agent > Channels** for normal channel setup and routing. See
[Channels](/channels) for provider-specific setup, then manage the selected
Agent’s account routes in the Control UI.

---

## Optimizations for small droplets

If the droplet has 1GB RAM, add swap and use API-based models instead of local
models.

### Add swap (recommended)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Use a lighter model

If you're hitting OOMs, consider:

- Using API-based models instead of local models
- Setting `agents.defaults.model.primary` to a smaller model

### Monitor memory

```bash
free -h
htop
```

---

## Persistence and backups

Gateway state lives under `/home/app/.fased`. Native signer keys, policy,
WebAuthn credentials, durable caps, and request records live separately in
signer-owned `/var/lib/fased-signerd`.

- `/home/app/.fased/` — Gateway config, credentials, sessions, and workspace
- `/var/lib/fased-signerd/` — signer-owned encrypted state and audit data

Both survive reboots and normal managed updates. Do not copy a live signer DB,
change its ownership, or treat only the public Gateway registry as a wallet
backup. Use a host-administrator maintenance window and the documented
signer-state backup/recovery procedure, then test recovery by comparing public
wallet addresses before funding the restored signer.

---

## Oracle Cloud alternative

Oracle Cloud has a provider-specific ARM path. It can be useful if capacity is
available and you are comfortable with OCI setup. For the full setup guide, see
[Oracle Cloud](/platforms/oracle).

---

## Troubleshooting

### Gateway won't start

```bash
fased gateway status
fased doctor --non-interactive
journalctl --user -u fased-gateway.service --no-pager -n 50
```

### Port already in use

```bash
lsof -i :18789
kill <PID>
```

### Out of memory

```bash
# Check memory
free -h

# Add more swap
# Or move to a larger droplet
```

---

## See Also

- [Hetzner guide](/install/hetzner) — same maintained Hosting installer
- [Local Docker install](/install/docker) — local computers only, not VPS hosting
- [Tailscale](/gateway/tailscale) — private remote access
- [Configuration](/gateway/configuration) — full config reference
