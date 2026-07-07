# Fased Host Security Baseline Checklist

Scope: host-native Fased gateway + `fased-signerd` (no Docker required).  
Goal: secure default for crypto workloads with private operator access and a
separate public Fased Network/A2A surface only where needed.

## Can Host-Native Automate This?

Yes, mostly:

- create non-root service users
- configure UFW/firewall rules
- install and bring up Tailscale
- install hardened systemd units
- enforce signer socket/file permissions
- restrict public exposure to the intended Fased Network/A2A edge only

Cannot be fully automated without prior identity:

- creating a brand-new Tailscale user account/login identity
- generating auth keys without an existing Tailscale account/API credentials

---

## Required Controls

### 1. Dedicated non-root runtime users (`required`)

```bash
sudo useradd --system --create-home --home-dir /var/lib/fased --shell /usr/sbin/nologin fased
sudo useradd --system --create-home --home-dir /var/lib/fased-signer --shell /usr/sbin/nologin fasedsigner
```

Run gateway and signer as these users (never as root).

### 2. Private admin network path via Tailscale (`required`)

For normal hosted VPS setup, use the hosted installer. It starts Tailscale when
needed, prints the login URL, and verifies private access before lock-down:

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh | bash -s -- --hosting
```

Manual hardening only: install and authenticate Tailscale yourself:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Admin access (SSH/UI) must use Tailscale only after bootstrap.

Bootstrap rule:

- first-login root SSH is acceptable for install and host prep
- after onboarding, day-to-day operator access should move to Tailscale SSH and
  the private dashboard URL
- disable password SSH and stop treating the public interface as an admin path

### 3. Firewall default deny + explicit allowlist (`required`)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Notes:

- Do **not** expose gateway admin port (e.g. `18789`) publicly.
- If you do not need host SSH from internet, do not allow `22/tcp` publicly.

### 4. Public exposure split (`required`)

- Admin/UI: private (Tailscale only).
- Fased Network/A2A: public via the dedicated public edge you intend to operate.
- Never reuse that public edge for privileged host admin access.

### 5. Systemd hardening for gateway (`required`)

Minimum hardening directives:

- `User=fased`
- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=true` (or `read-only` with explicit writable dirs)
- `ReadWritePaths=` only for required state/log dirs
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`
- `LockPersonality=true`
- `MemoryDenyWriteExecute=true`

### 6. Systemd hardening for signer (`required`)

Minimum hardening directives:

- `User=fasedsigner`
- `UMask=0077`
- `RuntimeDirectory=fased-signerd`
- signer socket mode `0600`
- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=true` / bounded writable dirs only

### 7. Signer isolation and key material protections (`required`)

- passphrase file mode `0600`
- keystore files mode `0600`
- signer audit log enabled
- signer PID lock enabled
- separate unix user from gateway process where possible

### 8. Disable password SSH login (`required`)

```bash
sudo install -d -m 0755 /etc/ssh/sshd_config.d
printf '%s\n' 'PasswordAuthentication no' 'PermitRootLogin no' | sudo tee /etc/ssh/sshd_config.d/01-fased-hardening.conf >/dev/null
sudo sshd -t
sudo systemctl restart ssh
```

If the image does not already load `/etc/ssh/sshd_config.d/*.conf`, add
`Include /etc/ssh/sshd_config.d/*.conf` near the top of `/etc/ssh/sshd_config`
before validating with `sshd -t`.

---

## Recommended Controls

### 9. Fail2ban (`recommended`)

```bash
sudo apt-get update
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

### 10. Automatic security updates (`recommended`)

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 11. Strict service restart/update flow (`recommended`)

Use explicit update flow:

1. pull/update code
2. rebuild
3. restart systemd units
4. run signer doctor/status checks

Avoid ad-hoc runtime `npm/pnpm` installs under privileged users.

### 12. Optional Docker mode (`recommended as alternate profile`)

Offer Docker as an alternate hardened profile, but keep the same baseline principles:

- non-root container user
- read-only rootfs where possible
- minimal writable volumes
- private admin path via Tailscale
- separate public edge only for A2A/public

---

## Service Checks (Post-Setup)

Run after install:

```bash
fased wallet signer doctor --json
fased wallet status --json
ss -ltnp | rg '18789|19444|22|443'
sudo ufw status verbose
```

Expected:

- signer doctor passes
- wallet status healthy for configured provider/signer mode
- admin ports not publicly exposed unintentionally
- firewall policy is default deny with explicit allows only

---

## Enforcement Recommendation

If end users are non-technical, make this baseline enforced by installer defaults:

- fail install/start when required controls are missing (unless `--allow-insecure` is explicitly set)
- print exact remediation commands
- keep compatibility/debug paths behind explicit advanced flags
