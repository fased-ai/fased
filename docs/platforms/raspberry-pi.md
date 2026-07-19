---
summary: "Fased on Raspberry Pi (budget self-hosted setup)"
read_when:
  - Setting up Fased on a Raspberry Pi
  - Running Fased on ARM devices
  - Running a small always-on Gateway
title: "Raspberry Pi"
---

# Fased on Raspberry Pi

## Goal

Run a persistent, always-on Fased Gateway on a Raspberry Pi.

Perfect for:

- 24/7 Fased Agent host
- Home automation hub
- Low-power, always-available Telegram/WhatsApp agent

## Hardware requirements

| Pi model        | RAM     | Fit       | Notes                    |
| --------------- | ------- | --------- | ------------------------ |
| **Pi 5**        | 4GB/8GB | Best      | Fastest path             |
| **Pi 4**        | 4GB     | Good      | Practical for most users |
| **Pi 4**        | 2GB     | OK        | Works with swap          |
| **Pi 4**        | 1GB     | Tight     | Minimal config only      |
| **Pi 3B+**      | 1GB     | Slow      | Works but sluggish       |
| **Pi Zero 2 W** | 512MB   | Too small | Not a good Gateway host  |

**Minimum specs:** 1GB RAM, 1 core, 500MB disk  
**Recommended:** 2GB+ RAM, 64-bit OS, 16GB+ SD card (or USB SSD)

## What You'll Need

- Raspberry Pi 4 or 5 (2GB+ recommended)
- MicroSD card (16GB+) or USB SSD (better performance)
- Power supply (official Pi PSU recommended)
- Network connection (Ethernet or WiFi)
- ~30 minutes

## 1) Flash the OS

Use **Raspberry Pi OS Lite (64-bit)** — no desktop needed for a headless server.

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Choose OS: **Raspberry Pi OS Lite (64-bit)**
3. Click the gear icon (⚙️) to pre-configure:
   - Set hostname: `gateway-host`
   - Enable SSH
   - Set username/password
   - Configure WiFi (if not using Ethernet)
4. Flash to your SD card / USB drive
5. Insert and boot the Pi

## 2) Connect via SSH

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3) Prepare the OS

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install the small bootstrap prerequisites
sudo apt install -y curl ca-certificates

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

The Fased installer installs and verifies the supported Node runtime. Do not
run a separate remote NodeSource setup script for the normal path.

## 5) Add Swap (Important for 2GB or less)

Swap prevents out-of-memory crashes:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) Install Fased

For the normal always-on Pi path, enter a root shell:

```bash
sudo -i
```

Then run the complete [verified Hosting bootstrap
block](/install/vps#3-verify-and-run-the-hosting-bootstrap). It authenticates
the tagged installer before execution, selects the supported ARM64 release,
installs the runtime, starts Tailscale through signed OS packages, creates the
non-root `app` service, and runs onboarding.

<Accordion title="Advanced: hackable source checkout">
  Contributors who intentionally need a source tree can use:

```bash
git clone https://github.com/fased-ai/fased.git fased
cd fased
pnpm install
pnpm build:app
./install.sh --no-onboard
```

This is a contributor/debug path, not the normal Pi installation.
</Accordion>

## 7) Private access before onboarding

The Hosting installer handles Tailscale login and private access checks. Open
the printed login URL on your own computer and confirm the requested private
SSH test before allowing public SSH hardening. Do not run an app-owned checkout
with sudo.

## 8) Run Onboarding

The installer runs onboarding automatically. If it was interrupted, reconnect
as `app` and resume:

```bash
fased onboard --install-daemon
```

After the Gateway is online, use the browser Control UI from the selected Agent:
**Agent > Models** for API keys/OAuth and model roles, **Agent > Channels** for
Telegram/WhatsApp/Discord routing, **Agent > Services** for web/search and API
connectors, and **Agent > Skills** for skill setup.

## 9) Verify Installation

```bash
# Check status
fased status

# Check service
fased gateway status

# View logs
journalctl --user -u fased-gateway.service -f
```

## 10) Access the Control UI

Since the Pi is headless, use an SSH tunnel:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

Use **Dashboard** for overview, **Chat** to test the Agent, **Agents** for
models, channels, skills, tools, memory, services, and tasks, and **Advanced >
Nodes** for paired device status.

Or use Tailscale Serve for always-on private access:

```bash
sudo tailscale serve --bg 443 http://127.0.0.1:18789
```

This keeps the Gateway loopback-only and gives you HTTPS on your tailnet access
path.

---

## Performance Optimizations

### Use a USB SSD

SD cards are slow and wear out. A USB SSD improves performance and durability:

```bash
# Check if booting from USB
lsblk
```

See [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) for setup.

### Reduce Memory Usage

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### Monitor Resources

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM-Specific Notes

### Binary Compatibility

Most Fased features work on ARM64, but some external binaries may need ARM builds:

| Tool               | ARM64 Status | Notes                               |
| ------------------ | ------------ | ----------------------------------- |
| Node.js            | ✅           | Works great                         |
| WhatsApp channel   | ✅           | Pure JS, no issues                  |
| Telegram           | ✅           | Pure JS, no issues                  |
| gog (Gmail CLI)    | ⚠️           | Check for ARM release               |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |

If a skill fails, check if its binary has an ARM build. Many Go/Rust tools do; some don't.

### 32-bit vs 64-bit

**Always use 64-bit OS.** Node.js and many modern tools require it. Check with:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## Recommended model setup

Since the Pi is just the Gateway (models run in the cloud), use API-based
models. Configure this in **Agent > Models**. If you need a raw config example:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.5",
        "fallbacks": ["openai/gpt-5.4-mini"]
      }
    }
  }
}
```

Use API-based models for the Pi. Local LLMs are usually too slow for a small
always-on Gateway host.

---

## Auto-Start on Boot

Onboarding with `--install-daemon` sets this up, but to verify:

```bash
# Check service is enabled
systemctl --user is-enabled fased-gateway.service

# Enable if not
systemctl --user enable fased-gateway.service

# Start on boot
systemctl --user start fased-gateway.service
```

---

## Troubleshooting

### Out of Memory (OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### Slow Performance

- Use USB SSD instead of SD card
- Disable unused services: `sudo systemctl disable cups bluetooth avahi-daemon`
- Check CPU throttling: `vcgencmd get_throttled` (should return `0x0`)

### Service Won't Start

```bash
# Check logs
journalctl --user -u fased-gateway.service --no-pager -n 100

# Common fix: rebuild
cd ~/fased  # if using hackable install
pnpm build:app
systemctl --user restart fased-gateway.service
```

### ARM Binary Issues

If a skill fails with "exec format error":

1. Check if the binary has an ARM64 build
2. Try building from source
3. Or use a Docker container with ARM support

### WiFi Drops

For headless Pis on WiFi:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## Cost planning

Actual cost depends on hardware, storage, power, and whether you already own the
device. Compare current Pi kit prices against a small VPS before buying hardware
only for Fased.

---

## See Also

- [Linux guide](/platforms/linux) — general Linux setup
- [DigitalOcean guide](/platforms/digitalocean) — cloud alternative
- [Hetzner guide](/install/hetzner) — maintained non-Docker VPS Hosting setup
- [Tailscale](/gateway/tailscale) — remote access
- [Nodes](/nodes) — operator docs for pairing laptop/phone nodes with the Pi gateway
