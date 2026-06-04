---
summary: "VPS hosting hub for Fased (Oracle/Fly/Hetzner/GCP and general VPS guidance)"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
title: "VPS Hosting"
---

# VPS hosting

This hub links to the supported VPS/hosting guides and explains the current
hosted Fased posture at a high level.

## VPS in 3 steps

For most users, the hosted path is:

1. Create a VPS and SSH into it.
2. Create or sign into a Tailscale account, then join the VPS to your tailnet.
3. Install Fased and choose the **Hosting** profile.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh

git clone https://github.com/fased-ai/fased.git fased
cd fased
./install.sh --hosting
```

## Recommended VPS size

Fased can install on a 1 vCPU / 1 GB RAM VPS, but that is the minimum floor and
onboarding will be slow. For a smoother first install, use at least:

| VPS size            | Use it for              | Expectation                                                           |
| ------------------- | ----------------------- | --------------------------------------------------------------------- |
| 1 vCPU / 1 GB RAM   | Cheapest test node      | Works with swap, but install/onboarding can take a long time.         |
| 1-2 vCPU / 2 GB RAM | Recommended minimum     | Much better first install and normal hosted operation.                |
| 2 vCPU / 4 GB RAM   | Comfortable public node | Faster builds, smoother Control UI, and more room for channels/tasks. |

Use a 25 GB disk or larger. Keep the raw Gateway port private; use Tailscale for
operator access.

Current installers try a clean fast-forward update from Git before building. If
you already started from an older installer and it stopped, update the checkout
once and rerun:

```bash
cd ~/fased
git pull --ff-only origin main
./install.sh --hosting
```

If you SSH into a fresh VPS as `root`, the installer creates a non-root `app`
user, prepares `/home/app/fased`, and re-runs the installer as `app`. That is
expected. After successful hosted onboarding, the temporary root checkout is
removed. Do not move the repo back to `/root`.

When `sudo tailscale up --ssh` prints a login URL in the SSH terminal, copy that
URL into your local computer's browser. The VPS does not need a desktop browser.

Before SSH/firewall lock-down, setup pauses and asks you to test terminal access
from your own computer:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
```

Only confirm after that command connects through Tailscale and opens
`/home/app/fased`. If it does not connect, setup stops before disabling root or
password SSH.
If the original VPS login was password-only and no SSH public key is available,
setup stops before hardening; add your public key and rerun.

After onboarding completes, use both access paths:

- **Web dashboard:** open the printed `https://...ts.net/` URL in a browser on
  your own computer. That computer must be signed into the same Tailscale
  account. Save the gateway token in case the browser asks for it.
- **SSH terminal:** use regular SSH over Tailscale as `app` for CLI commands,
  updates, logs, and repairs. Run it from a computer signed into the same
  Tailscale network.

Then leave the original `root@...:~/fased` bootstrap shell. Normal operation
uses the `app` user over Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased status
fased dashboard
```

The `app` shell is configured to start in `/home/app/fased`.

Root SSH is only for first bootstrap or emergency repair after the hosting
profile hardens SSH/UFW. Keep the raw Gateway port closed to the public
internet. `http://localhost:18789` is only the advanced SSH tunnel fallback: it
works on your local computer after you start the tunnel shown by onboarding and
leave that tunnel running.

<Note>
Small VPS installs create swap when possible and run onboarding with a larger
Node heap. If an older checkout already failed with `JavaScript heap out of
memory`, update the checkout and rerun `./install.sh --hosting`.
</Note>

## Update later

For normal updates, log in as `app` through Tailscale:

```bash
ssh app@YOUR_VPS_TAILSCALE_NAME
fased update status
fased update
```

If the browser Control UI is reachable, **Update & Restart** uses the same
gateway update path. Rerun `./install.sh --hosting` only for repair/reinstall
behavior; current installers fast-forward a clean Git checkout before building.

<Note>
You do not need a Tailscale API key for the normal manual VPS flow. The
Tailscale CLI prints a URL you open from your own computer. Use a Tailscale auth
key only for non-interactive automation, cloud-init, Terraform, or scripted installs.
</Note>

<Warning>
Run this on the VPS, not from a laptop trying to configure another machine.
Hosting onboarding needs permission to apply host security and verify Tailscale
before it closes public management paths.
</Warning>

## Pick a provider

- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/month (Always Free, ARM; capacity/signup can be finicky)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **Other VPS providers**: a clean Ubuntu LTS box usually works fine if you follow
  the same hosting/onboarding and Tailscale guidance.

Fased docs only list hosted install methods backed by files in this repository,
for example `deploy/hosting/fly.toml`, `deploy/hosting/render.yaml`, Docker, or the repo installer. External
hosted presets are intentionally not listed because we cannot verify or maintain
them from this repo.

## How cloud setups work

- The **runtime and gateway run on the VPS** and own state + workspace.
- Root installs are bootstrapped into `/home/app/fased` and run as the `app`
  user. The root checkout is temporary bootstrap state.
- Treat the VPS as the source of truth and **back up** the state + workspace.
- Create or sign into **Tailscale before onboarding** that host. If you skip
  this, Hosting onboarding will stop to install/login Tailscale before it locks
  down SSH/firewall rules.
- Use `fased onboard --host-profile hosting` for the hosted path.
- Keep the gateway on loopback and access it via the private Tailscale HTTPS
  dashboard URL or SSH over the Tailscale network.
- Do **not** expose the raw gateway port publicly just to reach the dashboard or WS.
- If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Remote access: [Gateway remote](/gateway/remote)  
Platforms hub: [Platforms](/platforms)

## Shared company agent on a VPS

This is a valid setup when the users are in one trust boundary (for example one
company team), and the runtime is business-only.

- Keep it on a dedicated runtime (VPS/VM/container + dedicated OS user/accounts).
- Do not sign that runtime into personal Apple/Google accounts or personal browser/password-manager profiles.
- If users are adversarial to each other, split by gateway/host/OS user.

Security model details: [Security](/gateway/security)

## Using nodes with a VPS

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
