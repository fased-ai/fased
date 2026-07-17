---
summary: "Install Fased on a GCP Compute Engine VM with the maintained Hosting profile"
read_when:
  - You want Fased running continuously on Google Compute Engine
  - You want the supported non-Docker hosting and Tailscale path
title: "GCP"
---

# Fased on GCP Compute Engine

Use a normal Compute Engine Linux VM and the maintained **Hosting** installer.
It creates the non-root application account, installs the independent native
signer and root updater, configures systemd, joins Tailscale, hardens remote
access, and keeps updates and rollback coordinated.

<Warning>
Do not run the full Docker Gateway on a GCP VM. Docker Gateway support is Local
only, and there is no `install.sh --hosting-docker` mode. On Compute Engine, use
`install.sh --hosting` exactly as shown below.
</Warning>

## What you need

- A Google Cloud project with billing and Compute Engine enabled
- A VM running Ubuntu LTS (recommended)
- Initial SSH access through `gcloud` or the Google Cloud console
- A Tailscale account
- Tailscale installed and signed into the same tailnet on your own computer
- Project/VM console access retained for emergency recovery

Use the general [VPS sizing guidance](/install/vps#recommended-vps-size) before
choosing a machine. Do not create a firewall rule for the raw Gateway port
(`18789`).

## 1. Create the VM

You can use the Compute Engine console, or create an Ubuntu LTS VM with
`gcloud`. Select the current Ubuntu LTS image family offered in your project
and a machine size that meets the VPS sizing guidance. For example:

```bash
gcloud compute instances create fased-gateway \
  --zone=YOUR_ZONE \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud
```

Provider image names can change; if that family is unavailable, select the
current Ubuntu LTS image in the console or list available families before
creating the VM.

## 2. Enter a root shell on the VM

```bash
gcloud compute ssh fased-gateway --zone=YOUR_ZONE
sudo -i
```

The remaining installation commands run **inside that root shell**, not on your
local computer.

## 3. Run the Hosting installer

From the provider root console, follow the
[pre-execution verified tagged bootstrap](/install/vps#3-install-fased-and-connect-through-tailscale).
It verifies the standalone installer attestation before any Fased shell code
runs as root. Do not install Docker, Node, Go, or Fased globally first.

When Tailscale prints a login URL, open that URL in the browser on your own
computer and approve the VM. Return to SSH only after the VM appears in the
correct tailnet. The installer stops before SSH/firewall lockdown if it cannot
verify a valid tailnet address.

## 4. Verify private access

From your own computer, with Tailscale connected to the same tailnet:

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
ssh app@YOUR_VPS_TAILSCALE_NAME
```

If no application SSH key was available during bootstrap, use:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

Do not close the bootstrap session until private access works.

## 5. Verify Fased

As the `app` user on the VM:

```bash
fased health
fased --version
fased gateway status
fased plugins doctor
fased wallet signer doctor --json
```

The install is ready only when health passes, the Gateway is running, the RPC
probe succeeds, plugins are clean, and signer doctor reports the expected
native protocol.

## 6. Open the Control UI privately

Keep the Gateway on loopback. If you need a direct browser tunnel, run this on
your own computer:

```bash
ssh -N -L 18790:127.0.0.1:18789 app@YOUR_VPS_TAILSCALE_NAME
```

Then open `http://127.0.0.1:18790/`. Use the dashboard/token instructions
printed by the installer; never publish port `18789` through a GCP firewall or
external load balancer.

## Updates and repair

For a normal update, connect as `app` over Tailscale and run:

```bash
fased update status
fased update
fased health
```

Use `install.sh --hosting` again only for an intentional hosted repair or
reinstall. See [VPS Hosting](/install/vps) and
[Updating and rollback](/install/updating) for the complete lifecycle and
backup guidance.

## Container note

Docker may still be installed on the same VM for optional per-session Agent
sandboxing while the Gateway and native signer remain managed by the host
installer. That is different from running the full Gateway in Docker. See
[Sandboxing](/gateway/sandboxing).
