---
title: Fly.io (unsupported archive)
description: Historical Fly.io deployment reference; not a supported Fased install path
summary: "Unsupported archived Fly.io container deployment"
read_when:
  - You found the legacy Fly.io manifests or an older Fly.io guide
  - You need to migrate a Fly.io deployment to a supported VPS
---

# Fly.io (unsupported archive)

Fased does not currently support running the full Gateway on Fly.io. The files
under `deploy/hosting/fly*.toml` are retained as historical reference and are
not a maintained, release-tested installation path.

<Warning>
Do not use the archived Fly manifests for a new deployment. They do not provide
the root-managed native signer/updater, separate signer application and control
sockets, Tailscale-first host hardening, coordinated rollback, or cold-reboot
validation required by the supported Hosting profile. Wallet, Vault, and SAT
mining must not be enabled on this path.
</Warning>

## Supported alternatives

- For an always-on server, provision a normal Linux VPS and run the maintained
  [VPS Hosting installer](/install/vps):

  Follow the [one-command VPS Hosting guide](/install/vps) from the provider
  root console.

- For a containerized Gateway on your own computer, use the supported
  [Local Docker](/install/docker) guide.

There is no `install.sh --hosting-docker` mode. A private Fly proxy or volume
does not make the archived deployment equivalent to the Hosting security and
update lifecycle.

## Migrating an existing Fly deployment

1. Stop changes to the existing deployment.
2. Export the configured Fased state directory and every Agent workspace.
3. Treat the export as sensitive because it can contain provider, channel, and
   session credentials. Do not copy signer or wallet material through an
   unreviewed migration script.
4. Install Fased on a clean VPS with `install.sh --hosting`.
5. Restore only reviewed, compatible non-custody configuration and workspace
   data, then re-enroll wallet custody through the native signer workflow.
6. Verify `fased health`, Gateway status, plugins, signer health, and each
   channel before deleting the old Fly volume or secrets.

Use the provider console to remove the legacy app, public IPs, volumes, and
secrets only after the new VPS is verified and backed up.
