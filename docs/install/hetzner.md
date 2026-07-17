---
summary: "Install Fased on a Hetzner VPS with the maintained Hosting profile"
read_when:
  - You want Fased running continuously on a Hetzner VPS
  - You want the supported non-Docker hosting and Tailscale path
title: "Hetzner"
---

# Fased on Hetzner

Use the maintained **Hosting** installer on a normal Linux VPS. It creates the
non-root application account, installs the independent native signer and root
updater, configures systemd, joins Tailscale, hardens remote access, and keeps
updates and rollback coordinated.

<Warning>
Do not run the full Docker Gateway on a Hetzner VPS. Docker Gateway support is
Local only, and there is no `install.sh --hosting-docker` mode. On Hetzner, use
`install.sh --hosting` exactly as shown below.
</Warning>

## What you need

- A Hetzner Cloud server with Ubuntu LTS (recommended)
- Initial root SSH access, preferably with an SSH key
- A Tailscale account
- Tailscale installed and signed into the same tailnet on your own computer
- The provider console/rescue path retained for emergency recovery

Use the general [VPS sizing guidance](/install/vps#recommended-vps-size) before
choosing a server. Do not open the raw Gateway port (`18789`) in a Hetzner
firewall.

## 1. Create and enter the server

Create an Ubuntu LTS server in Hetzner Cloud and attach your SSH public key.
Keep public SSH available only for initial bootstrap; the installer verifies
the private Tailscale path before applying its remote-access hardening.

```bash
ssh root@YOUR_PUBLIC_VPS_IP
```

The remaining installation commands run **inside that SSH session**, not in a
PowerShell or Terminal window on your local computer.

## 2. Run the Hosting installer

```bash
curl -fsSL https://raw.githubusercontent.com/fased-ai/fased/main/install.sh \
  | bash -s -- --hosting
```

The installer bootstraps the matching repository/runtime itself. Do not install
Docker, Node, Go, or Fased globally first.

When Tailscale prints a login URL, open that URL in the browser on your own
computer and approve the server. Return to SSH only after the server appears in
the correct tailnet. The installer stops before SSH/firewall lockdown if it
cannot verify a valid tailnet address.

## 3. Verify private access

From your own computer, with Tailscale connected to the same tailnet:

```bash
tailscale ping YOUR_VPS_TAILSCALE_NAME
ssh app@YOUR_VPS_TAILSCALE_NAME
```

If the initial provider login was password-only and no application SSH key was
available, use Tailscale SSH:

```bash
tailscale ssh app@YOUR_VPS_TAILSCALE_NAME
```

Do not close the bootstrap session until private access works.

## 4. Verify Fased

As the `app` user on the VPS:

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

## 5. Open the Control UI privately

Keep the Gateway on loopback. If you need a direct browser tunnel, run this on
your own computer:

```bash
ssh -N -L 18790:127.0.0.1:18789 app@YOUR_VPS_TAILSCALE_NAME
```

Then open `http://127.0.0.1:18790/`. Use the dashboard/token instructions
printed by the installer; never publish port `18789` to the internet.

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

Docker may still be installed on the same VPS for optional per-session Agent
sandboxing while the Gateway and native signer remain managed by the host
installer. That is different from running the full Gateway in Docker. See
[Sandboxing](/gateway/sandboxing).
