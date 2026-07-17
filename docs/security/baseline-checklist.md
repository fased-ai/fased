# Fased Host Security Baseline Checklist

Scope: maintained VPS Hosting with the host-native Gateway and independent
`fased-signerd`. Full Docker Gateway support is Local only.
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

The Hosting installer creates the non-root Gateway account (default `app`) and
the locked `fased-signer` account. Do not replace them with ad hoc `fased` or
`fasedsigner` users.

```bash
getent passwd app fased-signer
sudo systemctl show fased-gateway.service -p User -p Group
sudo systemctl show fased-signerd.service -p User -p Group -p SupplementaryGroups
```

The Gateway and signer never run as root. A separate fixed root updater is
intentional: it verifies and transactionally replaces the root-owned signer
binary. The Gateway has no signer sudo access.

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

- `User=app` for the default Hosting account
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

- `User=fased-signer`
- `UMask=0077`
- `RuntimeDirectory=fased-signerd`
- application socket `/run/fased-signerd/app.sock` mode `0660`, group-authorized
  for the Gateway
- control socket `/run/fased-signerd/control.sock` mode `0600`, signer only
- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=true` / bounded writable dirs only

### 7. Signer isolation and key material protections (`required`)

- `/var/lib/fased-signerd` is `0700`, owned by `fased-signer`
- `state.db`, `master.key`, and `audit.jsonl` are signer-owned and never mounted
  or exposed to the Gateway
- Go owns creation/import/re-encryption; normal Node/Gateway code never receives
  plaintext key material
- fail-closed policy, signer WebAuthn, durable cap/idempotency state, and
  signer-owned execution RPC live in signer state
- Gateway can connect only to the typed application socket and has no control
  socket or signer sudo path

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

Use the managed update flow:

1. run `fased update` from the managed Hosting runtime
2. let the fixed root updater verify the exact tagged signer digest and GitHub
   attestation
3. let it gate mutations, snapshot state, install/restart, verify health, and
   commit or roll back the coordinated Gateway/signer transaction
4. run signer doctor/status and cold-restart checks

Avoid ad hoc `git pull`, runtime `npm/pnpm`, binary replacement, or custom
systemd drop-ins under privileged users.

### 12. Docker support boundary (`required`)

Full Docker Gateway is a Local-only installation path. Do not present it as a
VPS Hosting profile. Maintained VPS/cloud installation uses
`install.sh --hosting` and the native systemd boundary above.

For Local Docker, keep these baseline principles:

- non-root container user
- read-only rootfs where possible
- minimal writable volumes
- loopback/private admin access
- signer app/control volumes separated from the Gateway

---

## Service Checks (Post-Setup)

Run after install:

```bash
fased wallet signer doctor --json
fased wallet status --json
sudo systemctl is-active fased-signerd.service fased-host-updater.service
sudo stat -c '%U:%G %a %n' \
  /var/lib/fased-signerd \
  /var/lib/fased-signerd/state.db \
  /var/lib/fased-signerd/master.key \
  /var/lib/fased-signerd/audit.jsonl \
  /run/fased-signerd/app.sock \
  /run/fased-signerd/control.sock
sudo -l -U app
ss -ltnp | rg '18789|19444|22|443'
sudo ufw status verbose
```

Expected:

- signer doctor passes
- `app` has no signer maintenance sudo command
- app socket is `0660`; control socket and signer state are inaccessible to `app`
- wallet status healthy for configured provider/signer mode
- admin ports not publicly exposed unintentionally
- firewall policy is default deny with explicit allows only

---

## Enforcement Recommendation

If end users are non-technical, make this baseline enforced by installer defaults:

- fail install/start when required controls are missing (unless `--allow-insecure` is explicitly set)
- print exact remediation commands
- keep compatibility/debug paths behind explicit advanced flags
