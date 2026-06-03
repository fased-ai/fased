---
summary: "Fased on Oracle Cloud (OCI ARM path)"
read_when:
  - Setting up Fased on Oracle Cloud
  - Looking for low-cost VPS hosting for Fased
  - Want 24/7 Fased on a small server
title: "Oracle Cloud"
---

# Fased on Oracle Cloud (OCI)

## Goal

Run a persistent Fased Gateway on Oracle Cloud's ARM path.

Oracle’s ARM instances can be a useful fit for Fased, especially if you already
have an OCI account, but they come with tradeoffs:

- ARM architecture (most things work, but some binaries may be x86-only)
- Capacity and signup can be finicky

## Prerequisites

- Oracle Cloud account
- Tailscale account
- ~30 minutes

## 1) Create an OCI Instance

1. Log into [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navigate to **Compute → Instances → Create Instance**
3. Configure:
   - **Name:** `fased`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 or more if available
   - **Memory:** 8-12 GB or more if available
   - **Boot volume:** 50 GB or more
   - **SSH key:** Add your public key
4. Click **Create**
5. Note the public IP address

**Tip:** If instance creation fails with "Out of capacity", try a different
availability domain or retry later.

## 2) Connect and Update

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Note:** `build-essential` is required for ARM compilation of some dependencies.

## 3) Configure User and Hostname

```bash
# Set hostname
sudo hostnamectl set-hostname fased

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4) Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=fased
```

This enables Tailscale SSH, so you can connect via `ssh fased` from any device on your tailnet — no public IP needed.

Verify:

```bash
tailscale status
```

**From now on, connect via Tailscale:** `ssh ubuntu@fased` (or use the Tailscale IP).

## 5) Install Fased with the hosting profile

```bash
git clone https://github.com/fased-ai/agent.git fased
cd fased
./install.sh --hosting
```

> Note: If you hit ARM-native build issues, start with system packages (e.g.
> `sudo apt install -y build-essential`) before reaching for Homebrew.

## 6) Optional: configure Tailscale Serve

The hosting installer can keep the Gateway private and print a Tailscale access
path. If you want Tailscale Serve explicitly:

```bash
# Expose over Tailscale Serve (HTTPS + tailnet access)
fased config set gateway.tailscale.mode serve
fased config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart fased-gateway
```

## 7) Verify

```bash
# Check version
fased --version

# Check daemon status
systemctl --user status fased-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8) Lock Down VCN Security

Now that everything is working, lock down the VCN to block all traffic except Tailscale. OCI's Virtual Cloud Network acts as a firewall at the network edge — traffic is blocked before it reaches your instance.

1. Go to **Networking → Virtual Cloud Networks** in the OCI Console
2. Click your VCN → **Security Lists** → Default Security List
3. **Remove** all ingress rules except:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Keep default egress rules (allow all outbound)

This blocks SSH on port 22, HTTP, HTTPS, and everything else at the network edge. From now on, you can only connect via Tailscale.

---

## Access the Control UI

Run this on the instance and open the printed private URL from a device on your
tailnet:

```bash
fased dashboard
```

If you configured Tailscale Serve explicitly, the URL is usually:

```
https://fased.<tailnet-name>.ts.net/
```

Replace `<tailnet-name>` with your tailnet name (visible in `tailscale status`).

Tailscale provides:

- HTTPS encryption (automatic certs)
- Authentication via Tailscale identity
- Access from any device on your tailnet (laptop, phone, etc.)

Inside the Control UI, use **Dashboard** for overview, **Chat** to test the
Agent, **Agents** for models/channels/skills/tools/memory/tasks, and
**Advanced** for Config, Debug, and Nodes.

---

## Security: VCN + Tailscale baseline

With the VCN locked down (only UDP 41641 open) and the Gateway bound to loopback,
public traffic is blocked at the network edge and admin access happens over your
tailnet.

This setup often removes the _need_ for extra host-based firewall rules purely to stop Internet-wide SSH brute force — but you should still keep the OS updated, run `fased security audit`, and verify you aren’t accidentally listening on public interfaces.

### What the VCN changes

| Traditional step   | Role after VCN lock-down | Why                                                                          |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| UFW firewall       | Usually secondary        | VCN blocks before traffic reaches instance                                   |
| fail2ban           | Usually secondary        | Port 22 is not internet-reachable when VCN rules are tight                   |
| sshd hardening     | Still review             | Tailscale SSH can reduce direct sshd exposure                                |
| Disable root login | Still review             | Keep normal OS hardening aligned with your access model                      |
| SSH key-only auth  | Still review             | Tailscale identity is the preferred access path                              |
| IPv6 hardening     | Verify                   | Depends on your VCN/subnet settings; verify what’s actually assigned/exposed |

### Still Recommended

- **Credential permissions:** `chmod 700 ~/.fased`
- **Security audit:** `fased security audit`
- **System updates:** `sudo apt update && sudo apt upgrade` regularly
- **Monitor Tailscale:** Review devices in [Tailscale admin console](https://login.tailscale.com/admin)

### Verify Security Posture

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Fallback: SSH Tunnel

If Tailscale Serve isn't working, use an SSH tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@fased
```

Then open `http://localhost:18789`.

---

## Troubleshooting

### Instance creation fails ("Out of capacity")

Capacity can be limited. Try:

- Different availability domain
- Retry during off-peak hours (early morning)
- Review the current provider shape and availability options

### Tailscale won't connect

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=fased --reset
```

### Gateway won't start

```bash
fased gateway status
fased doctor --non-interactive
journalctl --user -u fased-gateway -n 50
```

### Can't reach Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart fased-gateway
```

### ARM binary issues

Some tools may not have ARM builds. Check:

```bash
uname -m  # Should show aarch64
```

Most npm packages work fine. For binaries, look for `linux-arm64` or `aarch64` releases.

---

## Persistence

All state lives in:

- `~/.fased/` — config, credentials, session data
- `~/.fased/workspace/` — workspace memory, notes, and generated files

Back up periodically:

```bash
tar -czvf fased-backup.tar.gz ~/.fased ~/.fased/workspace
```

---

## See Also

- [Gateway remote access](/gateway/remote) — other remote access patterns
- [Tailscale integration](/gateway/tailscale) — full Tailscale docs
- [Gateway configuration](/gateway/configuration) — all config options
- [DigitalOcean guide](/platforms/digitalocean) — simpler VPS setup path
- [Hetzner guide](/install/hetzner) — Docker-based alternative
