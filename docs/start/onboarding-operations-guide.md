# Onboarding Operations Guide

It is written for the current Fased operating model:

## 1. Before you start

Decide three things before you run onboarding:

1. is this machine the primary runtime host
2. is this a personal machine or a hosted/VPS machine
3. how will private admin access work

Minimum preflight:

- machine you control
- private access path such as Tailscale or SSH
- plan for backup and recovery
- willingness to keep admin access private

## 2. Primary entry commands

Install and onboard with the right profile:

- **Local:** use `./install.sh` from the checkout, or the Local curl bootstrap
  in [Getting Started](/start/getting-started).
- **VPS Hosting:** use the exact tagged, attested curl bootstrap from the
  provider root console in [Getting Started](/start/getting-started). Never run
  `/home/app/fased/install.sh` with sudo or as root.

Run onboarding directly after install:

```bash
fased onboard --install-daemon
```

Hosted or VPS-style onboarding:

```bash
fased onboard \
  --non-interactive \
  --accept-risk \
  --host-profile hosting \
  --install-daemon
```

Tailscale authentication must already have been completed by the root Hosting
installer. Normal installs use its browser login URL. For unattended
provisioning, prepare the secret without putting it in shell history or process
arguments, then append the file option to the verified standalone Hosting
installer command:

```bash
install -m 0600 -o root -g root /dev/null /root/fased-tailscale-authkey
read -rsp "Tailscale auth key: " TAILSCALE_AUTHKEY </dev/tty
printf '\n'
printf '%s\n' "$TAILSCALE_AUTHKEY" > /root/fased-tailscale-authkey
unset TAILSCALE_AUTHKEY
```

Append `--ts-authkey-file /root/fased-tailscale-authkey` to the verified
standalone Hosting installer command. As soon as it finishes, run
`rm -f /root/fased-tailscale-authkey`. Run these commands only in the provider
root console. `fased onboard` does not accept Tailscale secrets, and raw
`--ts-authkey <key>` arguments are rejected.

Bootstrap note:

- initial SSH/root access is only for first install and host prep
- after onboarding, day-to-day admin access should move to SSH over the
  Tailscale network and the private dashboard URL
- do not leave the raw gateway port exposed just because initial setup used SSH

## 3. Profile and mode model

Do not confuse:

- `host profile`
- `mode`

Use this distinction:

- `host profile` controls how this machine behaves as a host
- `mode` controls whether this machine is hosting the runtime or only connecting to another runtime

### `local`

Use when:

- this machine is your own runtime host
- you want the most conservative learning path
- browser dashboard and private admin matter more than long-lived hosted presence

### `hosting`

Use when:

- this machine is a VPS or always-on node
- you expect managed runtime behavior
- you want a cleaner fit for long-lived Fased Network participation

### `remote`

Treat `remote` as a client connection mode.

## 4. Onboarding decisions that matter

These decisions carry the most long-term consequence.

### Host posture

- `--flow quickstart|advanced|manual`
- `--mode local|remote`
- `--host-profile local|hosting`

### Gateway and auth

- `--gateway-port <port>`
- `--bind loopback|tailnet|lan|auto|custom`
- `--gateway-auth token|password`

### Private access and service behavior

- `--tailscale off|serve|funnel`
- `--install-daemon`
- root installer only: `--ts-authkey-file <root-owned-mode-0600-file>`

### Wallet posture

- `--wallet-enabled`
- `--wallet-disabled`
- `--wallet-chains solana`

Public Fased docs assume the self-hosted wallet path when the runtime is used for real economic behavior.

### Fased Network direction

Fased Network is not required for first boot.

If you enable it during onboarding, remember:

- enrollment is not the same as healthy public routing
- managed runtime behavior still matters after restart

## 5. First health verification

Before you touch real funds or higher-risk plugins, confirm:

```bash
fased status
fased health
fased dashboard
```

If wallets are enabled, also confirm:

```bash
fased wallet signer doctor --json
fased wallet status --json
```

Your first safe milestone is:

- runtime stable
- private access stable
- restart behavior sane
- auth and bind posture intentional

## 6. Wallet architecture before funding

Do not invent wallet architecture from the dashboard after the fact.

Decide the working model first:

Recommended progression:

- create/import with an explicit role and record both registry and canonical signer ids
- enter one RPC; the signer derives its network and verification witness
- verify the built-in role baseline and signer/network readiness
- add an optional Vault approval device through the native signer-owner ceremony
  only when that Vault needs manual signing
- only then fund a deliberately small balance
- explicit `@wallet:<walletId>` handles for risky wallet actions
- broad automation only after the signer path is proven

## 7. Plugin rollout

Use this order:

1. observation plugins
2. workflow plugins
3. economic execution plugins

If a plugin can move value, define:

- which wallet it uses
- which limits bound it
- how you will disable it quickly

## 8. Fased Network bring-up

Fased Network is the network participation layer.

Operationally, it means the runtime can:

- register a handle
- hold Fased Network token state
- appear in routing and trust systems
- expose a public hosted route when the managed path is healthy

Useful checks:

```bash
fased federation status
fased federation token
fased federation paths
```

Important rule:

- token present does not mean public route healthy
- hosted state does not mean the runtime is actually reachable

## 10. Recovery priorities

If behavior drifts, recover in this order:

Useful commands:

Service checks:

```bash
systemctl --user status fased-gateway
systemctl --user restart fased-gateway
```

Hosted fallback:

```bash
sudo systemctl status fased-gateway
sudo systemctl restart fased-gateway
```

## 11. First-week operator rules

During the first week, change only one major layer at a time:

That is how you keep failures attributable and recovery sane.
