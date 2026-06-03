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

## 3) Join Tailscale

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates

curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname=fased-do
```

## 4) Install Fased with the hosting profile

For hosted deployments, run the hosting installer on the VPS itself.

```bash
apt install -y git
git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --hosting
```

The hosting installer runs onboarding and walks you through:

- Host profile, workspace, Gateway bind/auth, and hosting security
- Gateway token generation
- Optional wallet/mining setup if you choose those paths
- Daemon installation (systemd)

After the Gateway is online, finish product setup in the Control UI from the
selected Agent: **Agent > Models**, **Agent > Channels**, **Agent > Services**,
**Agent > Skills**, **Agent > Memory**, and **Agent > Tasks**.

## 5) Verify the Gateway

```bash
# Check status
fased status

# Check service
systemctl --user status fased-gateway.service

# View logs
journalctl --user -u fased-gateway.service -f
```

## 6) Access the Control UI

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
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

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

- Serve keeps the Gateway loopback-only and authenticates Control UI/WebSocket traffic via Tailscale identity headers (tokenless auth assumes trusted gateway host; HTTP APIs still require token/password).
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

## Persistence

All state lives in:

- `~/.fased/` — config, credentials, session data
- `~/.fased/workspace/` — workspace memory, notes, and generated files

These survive reboots. Back them up periodically:

```bash
tar -czvf fased-backup.tar.gz ~/.fased ~/.fased/workspace
```

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

- [Hetzner guide](/install/hetzner) — Docker-based VPS path
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — private remote access
- [Configuration](/gateway/configuration) — full config reference
