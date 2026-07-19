---
summary: "Supported local Docker setup and onboarding for Fased"
read_when:
  - You want a containerized gateway on your local computer
  - You are validating the Docker flow
title: "Docker"
---

# Local Docker (optional)

Docker is **optional** and the full Docker Gateway is supported only on a local
computer. Fased does not currently support a Docker-hosted Gateway on a VPS or
cloud server, and there is no `install.sh --hosting-docker` mode.

For a maintained VPS deployment, use the non-Docker
[one-command Hosting installer](/install/vps) from the provider root console.
It verifies the tagged Hosting release before privileged Fased installation
and manages the `app` account, Tailscale,
firewall and SSH hardening, systemd service, updates, and
rollback. The local Docker setup does not provide those hosting controls and
must not be substituted for it.

## Is Docker right for me?

- **Yes**: you want an isolated Gateway on your own local computer without a
  native Fased installation.
- **No**: you are running on your own machine and want the fastest dev loop. Use
  the normal install flow instead.
- **No for VPS/cloud hosting**: use `install.sh --hosting`; full Docker hosting
  is not a supported deployment path.
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not**
  require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).

This guide covers:

- Containerized Gateway (full Fased in Docker)
- Per-session Agent Sandbox (host gateway + Docker-isolated agent tools)

Sandboxing details: [Sandboxing](/gateway/sandboxing)

## Requirements

- Docker Desktop (or Docker Engine) with a current Docker Compose v2. The
  supplied setup uses Compose health dependencies and `docker compose up --wait`.
- Linux: run the commands from Bash.
- macOS: run the commands from Terminal. Docker runs the Linux signer image on
  both Apple silicon and Intel Macs.
- Windows: Windows 11, or Windows 10 version 2004/build 19041 or newer, with
  WSL2, Ubuntu, Docker Desktop's WSL2 backend, and Ubuntu integration enabled.
  Run every Fased command below in the **Ubuntu WSL2 shell**, never PowerShell,
  Command Prompt, or Git Bash. Microsoft's setup instructions are
  [Install WSL](https://learn.microsoft.com/windows/wsl/install) and
  [Use systemd in WSL](https://learn.microsoft.com/windows/wsl/systemd).
- At least 2 GB RAM when building the image from source. On 1 GB hosts,
  `pnpm install` may be OOM-killed with exit 137.
- Enough disk for images + logs

On a current Windows installation, open Administrator PowerShell only for the
one-time WSL installation:

```powershell
wsl --install -d Ubuntu
wsl --update
wsl --version
wsl --list --verbose
```

Restart Windows if requested, open **Ubuntu**, finish the Linux username setup,
then enable the Ubuntu distribution in Docker Desktop under **Settings >
Resources > WSL Integration**. Current Ubuntu installations made by
`wsl --install` use systemd. If an older distribution does not, update WSL to
0.67.6 or later, ensure the exact installed distribution shows version 2, add
the following inside Ubuntu, and run `wsl --shutdown` once
from PowerShell:

```ini
# /etc/wsl.conf
[boot]
systemd=true
```

Return to the Ubuntu shell and verify `docker version` and
`docker compose version` before continuing. These are **Ubuntu/WSL Bash**
commands, not PowerShell commands:

```bash
uname -s
systemctl is-system-running || true
docker version
docker compose version
```

`uname -s` must print `Linux`. Keep the later clone, `docker-setup.sh`, update,
backup, and rollback commands in this same Ubuntu shell.

## Containerized Gateway (Docker Compose)

The curl installers and Docker are separate installation paths:

| Goal                                      | Installation path      | Runs in Docker |
| ----------------------------------------- | ---------------------- | -------------- |
| Fased on your computer                    | `install.sh --local`   | No             |
| Fased in Docker on your computer          | This guide             | Yes            |
| Maintained VPS hosting with Tailscale     | `install.sh --hosting` | No             |
| Full Docker Gateway on a VPS/cloud server | Not supported          | —              |

### Install from the public image (recommended)

Open the latest stable entry on
[GitHub Releases](https://github.com/fased-ai/fased/releases), copy its version
without the leading `v`, then clone and run that exact release. Keep the source
tag and image tag identical:

```bash
export FASED_VERSION="<stable-version>"
git clone --branch "v${FASED_VERSION}" --depth 1 https://github.com/fased-ai/fased.git fased
cd fased
FASED_IMAGE="ghcr.io/fased-ai/fased:${FASED_VERSION}" ./docker-setup.sh
```

The image is public and supports anonymous pulls for `linux/amd64` and
`linux/arm64`. Users do not need a Docker Hub account, GitHub account, package
token, or `docker login`. Tagged images contain a production-stamped signer;
its version, release commit, and signer build-input digest are exposed through
signer health and must match the exact image selected during an update.

For an immutable local deployment, download that release's
`fased-container-vX.Y.Z.json` plus attestation bundle, verify it with the exact
tag and Docker release workflow constraints shown in
[Update local Docker](#update-local-docker), and use its multi-architecture
manifest digest directly:

```bash
FASED_IMAGE='ghcr.io/fased-ai/fased@sha256:<verified-manifest-digest>' \
  ./docker-setup.sh
```

`latest` is available for convenience, but a version tag or digest is safer
when reproducibility matters:

```bash
FASED_IMAGE=ghcr.io/fased-ai/fased:latest ./docker-setup.sh
```

With a published `FASED_IMAGE`, the setup script:

- pulls the selected multi-architecture image, which contains both Fased and
  the matching native `fased-signerd`
- refuses to replace an existing signer through the fresh-install path; Docker
  updates must use the offline transaction later in this guide
- creates the non-root signer service and waits for protocol-v2 health **before**
  any wallet operation
- runs CLI onboarding
- prints dashboard, token, and pairing hints
- recreates and health-checks the Gateway
- generates a gateway token and writes it to `.env`
- records the selected image in `.env`

Optional env vars:

- `FASED_IMAGE` — use a selected image instead of building `fased:local`
- `FASED_DOCKER_APT_PACKAGES` — install extra apt packages during build
- `FASED_EXTRA_MOUNTS` — add extra host bind mounts
- `FASED_HOME_VOLUME` — persist `/home/node` in a named volume

After it finishes:

- Open `http://localhost:18789/` in your browser.
- Paste the token from `.env` or the dashboard link if the browser asks for one.
- In the UI, finish setup from the selected Agent: **Models** first, then **Chat**.
- Need the URL again? Run `docker compose run --rm fased-cli dashboard --no-open`.

It writes config/workspace on the host:

- `~/.fased/`
- `~/.fased/workspace`

Signer keys, durable limits, idempotency records, policies, and audit state live
in the Compose-managed `fased-signer-state` volume. The policy-limited
application socket and administrative control socket use separate
`fased-signer-app-run` and `fased-signer-control-run` volumes. The always-running
Gateway and routine `fased-cli` mount only the application volume. Do not run
`docker compose down -v` unless you intentionally want to destroy signer state
and its wallets.

### Build locally from source (alternative)

Use the source-build path when auditing or modifying the Dockerfile, testing
unreleased source, or adding build-time packages. Select a stable release for a
normal local build:

```bash
export FASED_VERSION="<stable-version>"
git clone --branch "v${FASED_VERSION}" --depth 1 https://github.com/fased-ai/fased.git fased
cd fased
./docker-setup.sh
```

Without `FASED_IMAGE`, `docker-setup.sh` builds `fased:local`, records that
selection in `.env`, reproducibly cross-builds the native Go signer for the
target image architecture, stamps it as a development build with the packaged
Fased version, runs onboarding, and starts the local services. A local
development identity is explicit and is not a substitute for the provenance of
a published release image. An `unauthorized` or `denied` error while using the
public-image path usually means the requested tag does not exist or Docker is
reusing stale credentials.

### Local security boundary

The supplied local Compose configuration:

- publishes Gateway and bridge ports on `127.0.0.1` only
- packages `fased-signerd` with the matching image and runs it as a separate,
  non-root `fased-signerd` service before Gateway or CLI wallet work
- keeps the signer database and master key in a signer-only persistent volume
- separates the policy-limited application socket from the administrative
  control socket; Gateway and routine `fased-cli` mount only the application
  socket
- exposes control access only through explicit, one-shot `fased-signer-admin`
  and `fased-signer-enroll` profile services; the admin service has no Gateway
  config, workspace, application socket, signer state, or network access
- requires a real protocol-v2 signer health response, not just a socket file
- makes Gateway and CLI treat signer lifecycle as external so Node cannot start
  a second signer process inside either container
- runs all three services as the non-root `node` user
- drops all Linux capabilities and enables `no-new-privileges`
- does not use host networking, privileged mode, or a container-engine socket
- health-checks both the native signer and Gateway
- stores the generated `.env` with user-only permissions
- excludes local `.env*`, `.fased`, SSH/private keys, and common credential
  directories from the image build context

This is **Local container isolation**, not the Hosting custody boundary. The
Gateway cannot mount signer state or the administrative control socket, but it
can request operations allowed by wallet policy through the application socket.
The local account and Docker daemon still control all containers and volumes, so
container separation does not protect a high-value reserve wallet from a fully
compromised host. Keep automated Agent and Mining wallets low-balance with
explicit typed policies and positive caps; use a hardware-backed Wallet
Standard account or a reviewed remote custody provider for reserve/Vault funds.

Do not change the port mappings to `0.0.0.0`, add `network_mode: host`, mount
`docker.sock`, or enable `privileged`. Those changes cross the supported local
security boundary. Do not change the services to root to work around
permissions. Remote access and Docker VPS hosting are not covered by this guide.

### Wallets and SAT mining

Local Docker supports signer-owned Solana Agent, Mining, and Vault wallet setup,
typed wallet operations, and SAT mining. The native signer is part of the image;
users do not install Go or download a second signer binary.

To create or manage wallets after initial onboarding:

```bash
docker compose run --rm fased-cli wallet setup --chain solana
```

New signer-owned wallets begin with a durable deny-all policy. Before funding a
wallet, review the exact role template under `config/signer-policies/`, set its
canonical signer wallet ID, exact programs/assets/destinations, and positive
per-transaction and daily caps. The friendly UI name and canonical signer ID
can differ; use the canonical ID printed by wallet setup. For example:

```bash
cp config/signer-policies/agent.json.template "$HOME/fased-agent-policy.json"
chmod 600 "$HOME/fased-agent-policy.json"
# Edit every REPLACE_WITH_ value and review every line before continuing.
scripts/docker-signer-policy.sh \
  --initial-install \
  --wallet-id agent \
  --policy-file "$HOME/fased-agent-policy.json"
```

The helper refuses placeholders, group/world-readable policy files, a policy
owned by another user, an unhealthy signer, a digest-confirmation mismatch, or
anything other than the first version-1 deny-all transition. It stages the
reviewed policy over standard input only in the one-shot admin container's
temporary filesystem; it never gives routine `fased-cli` the control socket and
prints the signer-acknowledged policy afterward. Empty operations, programs,
and assets still grant nothing; generic raw signing is not enabled.

For a native administrative command not covered by the initial-policy helper,
use the explicit profile service. Never use `docker compose exec
fased-signerd ... admin` and never add the control volume back to `fased-cli`:

```bash
docker compose --profile signer-admin run --rm --no-deps \
  fased-signer-admin policy get \
  --control-socket /run/fased-signerd-control/control.sock \
  --wallet-id agent
```

This service is deliberately short-lived and networkless. Review every admin
command and its input from the local owner terminal before running it.

Jupiter Trigger orders use a separate API key owned only by the native signer.
The Gateway's `FASED_JUPITER_API_KEY` is for ordinary swap quote/transaction
crafting and does not enable Trigger. Put the Trigger key in a private file,
stream it to the networkless admin container, and restart only the signer:

```bash
chmod 600 /absolute/path/to/jupiter-trigger.key
docker compose --profile signer-admin run --rm -T --no-deps \
  fased-signer-admin jupiter api-key-install \
  --output /var/lib/fased-signerd-secrets/jupiter-trigger-api.key \
  < /absolute/path/to/jupiter-trigger.key
docker compose restart fased-signerd
```

The one-shot admin receives the key only on stdin and atomically writes it to a
dedicated signer-secret volume. Gateway, routine CLI, enrollment, and signer
state volumes do not receive that volume. The signer reports only whether
Trigger is configured; it never returns the key or its Jupiter JWT. Check or
remove the credential without printing it:

```bash
docker compose --profile signer-admin run --rm -T --no-deps \
  fased-signer-admin jupiter api-key-status \
  --output /var/lib/fased-signerd-secrets/jupiter-trigger-api.key

docker compose --profile signer-admin run --rm -T --no-deps \
  fased-signer-admin jupiter api-key-remove \
  --output /var/lib/fased-signerd-secrets/jupiter-trigger-api.key
docker compose restart fased-signerd
```

If no Trigger key is installed, wallet creation, SOL/SPL transfers, SAT mining,
and reviewed Vault operations continue to work; Trigger history/create/cancel
fail closed with a configuration error.

Vault operations and any separately enabled owner-review lane require a
signer-owned approval credential. Agent and Mining automation inside narrow
policy does not prompt for a passkey. This is separate from the optional Control
UI account passkey. Run the one-shot enrollment service, open the printed
`http://localhost:18791` URL on the same computer, and touch/approve your
authenticator:

```bash
docker compose --profile signer-admin run --rm --service-ports \
  fased-signer-enroll "Local Docker owner"
```

The enrollment port is published on host loopback only and exists only while
that one-shot command runs. Continue with
[Agent, wallet, and mining walkthrough](/start/agent-wallet-mining-walkthrough).

The signer state survives normal container recreation and `docker compose down`.
It does **not** survive `docker compose down -v` or manual removal of the
project's `fased-signer-state` and `fased-signer-secrets` volumes. Stop both
Gateway and signer before an offline backup; never copy the live bbolt database
while the signer is running. A complete recovery point must include both named
volumes, the host paths in `FASED_CONFIG_DIR` and `FASED_WORKSPACE_DIR`, `.env`,
the base and extra Compose files, and the exact immutable image identity. The
coordinated update helper below captures and checksums that complete set.

Run `docker compose ...` from the repo root. If you enabled
`FASED_EXTRA_MOUNTS` or `FASED_HOME_VOLUME`, the setup script writes
`docker-compose.extra.yml`; include it when running Compose elsewhere:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI token + pairing (Docker)

If you see “unauthorized” or “disconnected (1008): pairing required”, fetch a
fresh dashboard link and approve the browser device:

```bash
docker compose run --rm fased-cli dashboard --no-open
docker compose run --rm fased-cli devices list
docker compose run --rm fased-cli devices approve <requestId>
```

More detail: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Setup after Docker starts

Use the browser UI for normal setup:

1. open `http://localhost:18789/`
2. choose the default Agent, shown as **Assistant**
3. configure model auth in **Agent > Models**
4. test one message in **Chat**
5. add channels in **Agent > Channels**
6. add API connectors in **Agent > Services**

The CLI onboarding command is still useful for automation, repair, or scripted
container setup, but normal users should not need to edit JSON by hand.

### Extra mounts (optional)

If you want to mount additional host directories into the containers, set
`FASED_EXTRA_MOUNTS` before running `docker-setup.sh`. This accepts a
comma-separated list of Docker bind mounts and applies them to both
`fased-gateway` and `fased-cli` by generating `docker-compose.extra.yml`.

Example:

```bash
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes:

- Paths must be shared with Docker Desktop on macOS/Windows.
- Each entry must be `source:target[:options]` with no spaces, tabs, or newlines.
- Prefer `:ro` unless the container must write to the mounted directory.
- Container-engine sockets such as `docker.sock` are rejected because they
  provide host-level control.
- If you edit `FASED_EXTRA_MOUNTS`, rerun `docker-setup.sh` to regenerate the
  extra compose file.
- `docker-compose.extra.yml` is generated. Don’t hand-edit it.

### Persist the entire container home (optional)

If you want `/home/node` to persist across container recreation, set a named
volume via `FASED_HOME_VOLUME`. This creates a Docker volume and mounts it at
`/home/node`, while keeping the standard config/workspace bind mounts. Use a
named volume here (not a bind path); for bind mounts, use
`FASED_EXTRA_MOUNTS`.

Example:

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

You can combine this with extra mounts:

```bash
export FASED_HOME_VOLUME="fased_home"
export FASED_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Notes:

- Named volumes must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- If you change `FASED_HOME_VOLUME`, rerun `docker-setup.sh` to regenerate the
  extra compose file.
- The named volume persists until removed with `docker volume rm <name>`.

### Install extra apt packages (optional)

If you need system packages inside the image (for example, build tools or media
libraries), set `FASED_DOCKER_APT_PACKAGES` before running `docker-setup.sh`.
This installs the packages during the image build, so they persist even if the
container is deleted.

Example:

```bash
export FASED_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Notes:

- This accepts a space-separated list of apt package names.
- If you change `FASED_DOCKER_APT_PACKAGES`, rerun `docker-setup.sh` to rebuild
  the image.

### Power-user / full-featured container (opt-in)

The default Docker image is minimal and runs as the non-root `node` user. This
keeps the attack surface small, but it means:

- no system package installs at runtime
- no Homebrew by default
- no bundled Chromium/Playwright browsers

If you want a more full-featured container, use these opt-in knobs:

1. **Persist `/home/node`** so browser downloads and tool caches survive:

```bash
export FASED_HOME_VOLUME="fased_home"
./docker-setup.sh
```

2. **Bake system deps into the image** (repeatable + persistent):

```bash
export FASED_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Install Playwright browsers without `npx`** (avoids npm override conflicts):

```bash
docker compose run --rm fased-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

If you need Playwright to install system deps, rebuild the image with
`FASED_DOCKER_APT_PACKAGES` instead of using `--with-deps` at runtime.

4. **Persist Playwright browser downloads**:

- Set `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` in
  `docker-compose.yml`.
- Ensure `/home/node` persists via `FASED_HOME_VOLUME`, or mount
  `/home/node/.cache/ms-playwright` via `FASED_EXTRA_MOUNTS`.

### Permissions + EACCES

The image runs as `node` (uid 1000). If you see permission errors on
`/home/node/.fased`, make sure your host bind mounts are owned by uid 1000.

Example (Linux host):

```bash
sudo chown -R 1000:1000 /path/to/fased-config /path/to/fased-workspace
```

Do not change Gateway, CLI, or signer to root. On Docker Desktop, use a named
home volume if host bind-mount ownership cannot be represented cleanly.

### Faster rebuilds

The supplied multi-stage Dockerfile caches Go modules and pnpm dependencies
before copying the remaining source. Keep using it: a simplified custom
Dockerfile that copies only the Node application will omit `fased-signerd` and
wallet/mining setup will fail closed.

### Channel setup (optional)

Use **Agent > Channels** in the Control UI for normal setup. It mirrors the
current channel onboarding flow and keeps account credentials separate from
Agent routing.

For scripted Docker setups, you can still run channel CLI commands through the
CLI container, then restart the gateway if that command changed runtime config.

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram),
[Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

If you pick OpenAI Codex OAuth from **Agent > Models**, it opens a browser URL
and tries to capture a callback on `http://127.0.0.1:1455/auth/callback`. In
Docker or headless setups that callback can show a browser error. Copy the full
redirect URL you land on and paste it back into the auth prompt to finish auth.

### Health check

```bash
docker compose exec fased-signerd \
  node /app/scripts/docker-signer-health.mjs /run/fased-signerd/app.sock
docker compose exec fased-gateway node dist/index.js health
```

Both commands must succeed. If signer health fails, do not retry wallet
creation repeatedly; inspect `docker compose logs --tail 100 fased-signerd`
first. The Gateway service already receives `FASED_GATEWAY_TOKEN` from `.env`;
the `health` command reads runtime config/env and does not take a `--token` flag.

### Update local Docker

Do not run `fased update` inside a container, edit `FASED_IMAGE` first, or
manually recreate `fased-signerd`. A new signer can migrate its bbolt database;
an older image may then correctly refuse that migrated state. Copying
`state.db` while the signer is running is not a backup.

Run the coordinated helper from the **currently running release checkout**.
Give it a new absolute snapshot directory on durable local storage and an
immutable image digest or unique version tag. For the high-assurance registry
path, verify the tagged release metadata and OCI image attestation before the
updater can stop either service. Install GitHub CLI from your operating
system's trusted package source, confirm `gh version`, replace `vX.Y.Z`, and
run:

```bash
(
set -euo pipefail
cd /path/to/fased
mkdir -p "$HOME/.local/state/fased/docker-signer-backups"

RELEASE=vX.Y.Z
VERIFY_DIR="$(mktemp -d)"
trap 'rm -rf "$VERIFY_DIR"' EXIT
chmod 0700 "$VERIFY_DIR"
curl -fsSLo "$VERIFY_DIR/fased-container-${RELEASE}.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/fased-container-${RELEASE}.json"
curl -fsSLo "$VERIFY_DIR/fased-container-${RELEASE}.attestation.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/fased-container-${RELEASE}.attestation.json"
curl -fsSLo "$VERIFY_DIR/fased-container-${RELEASE}.image-attestation.json" \
  "https://github.com/fased-ai/fased/releases/download/${RELEASE}/fased-container-${RELEASE}.image-attestation.json"
GH_PROMPT_DISABLED=1 gh attestation verify \
  "$VERIFY_DIR/fased-container-${RELEASE}.json" \
  --repo fased-ai/fased \
  --bundle "$VERIFY_DIR/fased-container-${RELEASE}.attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/docker-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners

MANIFEST_DIGEST="$(sed -n 's/.*"manifestDigest": "\(sha256:[a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
RELEASE_COMMIT="$(sed -n 's/.*"releaseCommit": "\([a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
SIGNER_BUILD_INPUT_DIGEST="$(sed -n 's/.*"signerBuildInputDigest": "\(sha256:[a-f0-9]*\)".*/\1/p' \
  "$VERIFY_DIR/fased-container-${RELEASE}.json")"
[[ "$MANIFEST_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$RELEASE_COMMIT" =~ ^[a-f0-9]{40}$ ]]
[[ "$SIGNER_BUILD_INPUT_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
GH_PROMPT_DISABLED=1 gh attestation verify \
  "oci://ghcr.io/fased-ai/fased@${MANIFEST_DIGEST}" \
  --repo fased-ai/fased \
  --bundle "$VERIFY_DIR/fased-container-${RELEASE}.image-attestation.json" \
  --signer-workflow fased-ai/fased/.github/workflows/docker-release.yml \
  --source-ref "refs/tags/${RELEASE}" \
  --deny-self-hosted-runners

scripts/docker-signer-update.sh \
  --image "ghcr.io/fased-ai/fased@${MANIFEST_DIGEST}" \
  --expected-release-commit "$RELEASE_COMMIT" \
  --expected-signer-build-input-digest "$SIGNER_BUILD_INPUT_DIGEST" \
  --snapshot-dir "$HOME/.local/state/fased/docker-signer-backups/pre-${RELEASE}"
)
```

The three downloaded files contain no credentials. The metadata attestation
binds the manifest digest and exact signer identity to the repository, tag,
workflow, and GitHub-hosted runner. The OCI attestation independently binds
that same manifest digest to the Docker release workflow. Stop if a download,
attestation, parse, or identity check fails. A unique version tag remains
accepted as a convenience path, but it does not provide the same pre-update
immutable verification.

The helper, in order:

1. pulls or resolves the target without starting it, reads the packaged Fased
   version, complete signer release identity, and target Compose definition
   from that exact image under a networkless, read-only container; it requires
   the Gateway and signer versions to match, requires a version tag to match
   that version, rejects a development signer in any registry target, and,
   when verified release metadata is supplied, requires the embedded commit and
   signer build-input digest to match it before stopping either service;
2. validates the target Compose definition with the current owner-controlled
   `.env` and optional `docker-compose.extra.yml` before stopping services;
3. stops Gateway and then `fased-signerd`;
4. verifies the signer is stopped and creates deterministic offline archives
   of `fased-signer-state`, `fased-signer-secrets`, the Gateway config/state
   bind mount, and the workspace bind mount;
5. checksums every archive plus the old and target `.env`/Compose definitions,
   records both complete signer identities and Gateway versions, and preserves
   the exact old image ID under a local rollback tag;
6. atomically installs the target Compose definition and pins `FASED_IMAGE` to
   the resolved target image ID;
7. creates the target signer without starting it and requires it to use both
   the exact target image ID and the existing signer-state volume;
8. starts the new signer and requires protocol v2, signer-owned atomic caps,
   the fixed native-fee reserve, and an exact match for the saved version,
   commit, build-input digest, and development marker; only then does it start
   the Gateway and verify its packaged release version.

If target activation fails, the helper stops it, erases the migrated signer
volumes and changed Gateway/workspace bind-mount contents while offline,
restores and re-verifies every exact snapshot, restores the exact old image,
atomically restores the old `.env` and Compose definition, and starts that
saved deployment. The same rollback runs automatically for any error or
interruption after the verified offline snapshot is armed. It fails closed
without starting either signer when an archive, metadata, volume, bind path,
release identity, or exact old image is unavailable.

The snapshot contains the signer master key, wallets, policy database, audit
state, signer-side API secrets, Gateway credentials and sessions, memory and
workspace data, and the Gateway token from `.env`. The helper creates its
directory as `0700` and its files as `0600`; keep that directory on owner-only
encrypted storage and never upload or share it.

This is a **same-host transactional rollback snapshot**, not a portable or
cross-machine disaster-recovery bundle. It depends on the saved local image ID,
Docker volume identities, and owner-controlled bind paths from this deployment.
For machine-loss recovery, maintain a separate encrypted backup and test its
restore on the same OS/architecture and Docker storage layout; do not present
the updater snapshot as a portable backup.

After success, the deployment directory already contains the target base
Compose definition extracted from the image. Verify the version and plugins,
then move the rest of the source checkout to the matching tag. Do not edit or
discard that Compose file first. Do not delete the snapshot or local rollback
image until you have deliberately ended the rollback window:

```bash
docker compose exec fased-gateway fased --version
docker compose run --rm fased-cli plugins doctor

git fetch origin --tags
git switch --detach vX.Y.Z
```

To roll back later, run the helper from the deployment directory and pass the
retained snapshot. It verifies all saved artifacts before touching signer
state, then restores the saved pre-update `.env`, Compose definition, image,
and state together:

```bash
scripts/docker-signer-update.sh \
  --rollback "$HOME/.local/state/fased/docker-signer-backups/pre-X.Y.Z"
```

For a source build, never overwrite `fased:local` before snapshotting because
that destroys the old image reference. Keep the running release checkout in
place, build the target tag from a separate checkout under a unique image tag,
then invoke the helper from the running release checkout:

```bash
git fetch origin --tags
git worktree add --detach ../fased-build-X.Y.Z vX.Y.Z
docker build --pull -t fased-local:X.Y.Z \
  -f ../fased-build-X.Y.Z/Dockerfile ../fased-build-X.Y.Z

scripts/docker-signer-update.sh \
  --image fased-local:X.Y.Z \
  --snapshot-dir "$HOME/.local/state/fased/docker-signer-backups/pre-X.Y.Z-local"
```

The updater rejects `latest` and `fased:local` because neither identifies a
stable rollback target.

Config and workspace survive while `FASED_CONFIG_DIR` and
`FASED_WORKSPACE_DIR` keep pointing to the same host directories. Signer keys,
policies, durable caps, and idempotency state survive in
`fased-signer-state`; signer-side integration secrets survive in
`fased-signer-secrets`. Normal `docker compose down` preserves them; `docker
compose down -v` destroys the volumes. The complete transaction snapshot is
intentionally outside every live path, so it survives a Compose volume
rollback.

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Notes

- Gateway bind inside the container is `lan` so Docker port forwarding works;
  the host-side port remains loopback-only.
- `fased-signerd` must be healthy before Gateway or CLI wallet commands run.
  Missing or incompatible signer binaries fail before onboarding.
- Dockerfile CMD uses `--allow-unconfigured`; mounted config with
  `gateway.mode` not `local` will still start. Override CMD to enforce the
  guard.
- The gateway container is the source of truth for sessions (`~/.fased/agents/<agentId>/sessions/`).

## Agent Sandbox (host gateway + Docker tools)

Deep dive: [Sandboxing](/gateway/sandboxing)

This is separate from running the whole Gateway in Docker. The Gateway can run
on the host while selected tool sessions run inside Docker containers.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.fased/sandboxes",
        docker: {
          image: "fased-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "fased-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Key defaults:

- one sandbox per agent by default
- sandbox workspace under `~/.fased/sandboxes`
- Docker network disabled by default
- host browser/camera/canvas are blocked by default
- `deny` tool policy wins over `allow`
- `scope: "shared"` disables cross-session isolation

For full precedence, browser sandboxing, per-agent overrides, and hardening
knobs, use [Sandboxing](/gateway/sandboxing) and
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools).

### Build the default sandbox image

```bash
scripts/sandbox-setup.sh
```

This builds `fased-sandbox:bookworm-slim` using `deploy/containers/Dockerfile.sandbox`.

### Optional sandbox images

If you want a sandbox image with common build tooling (Node, Go, Rust, etc.), build the common image:

```bash
scripts/sandbox-common-setup.sh
```

This builds `fased-sandbox-common:bookworm-slim`. To use it:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "fased-sandbox-common:bookworm-slim" } },
    },
  },
}
```

To run the browser tool inside the sandbox, build the browser image:

```bash
scripts/sandbox-browser-setup.sh
```

### Custom sandbox image

Build your own image and point config to it:

```bash
docker build -t my-fased-sbx -f deploy/containers/Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-fased-sbx" } },
    },
  },
}
```

### Isolation notes

- Hard wall only applies to **tools** (exec/read/write/edit/apply_patch).
- Host-only tools like browser/camera/canvas are blocked by default.
- Allowing `browser` in sandbox **breaks isolation** (browser runs on host).

## Troubleshooting

- Image missing: build with
  [`scripts/sandbox-setup.sh`](https://github.com/fased-ai/fased/blob/main/scripts/sandbox-setup.sh)
  or set `agents.defaults.sandbox.docker.image`.
- Container not running: it will auto-create per session on demand.
- Permission errors in sandbox: set `docker.user` to a UID:GID that matches your
  mounted workspace ownership (or chown the workspace folder).
- Custom tools not found: Fased runs commands with `sh -lc` (login shell), which
  sources `/etc/profile` and may reset PATH. Set `docker.env.PATH` to prepend your
  custom tool paths (e.g., `/custom/bin:/usr/local/share/npm-global/bin`), or add
  a script under `/etc/profile.d/` in your Dockerfile.
