---
summary: "Move (migrate) a Fased install from one machine to another"
read_when:
  - You are moving Fased to a new laptop/server
  - You want to preserve sessions, auth, and channel logins (WhatsApp, etc.)
title: "Migration Guide"
---

# Migrating Fased to a new machine

This guide migrates a Fased Gateway and, when enabled, its native wallet signer
from one machine to another. Wallet migration requires a coordinated offline
snapshot; copying only `~/.fased` is not sufficient on Hosting.

The migration is simple conceptually:

- Copy the **Gateway state directory** (`$FASED_STATE_DIR`, default:
  `~/.fased/`). This includes config, auth, sessions, channel state, and Local
  signer state.
- Copy your **workspace** (`~/.fased/workspace/` by default). This includes your
  agent files, memory, prompts, and related workspace content.
- On **Hosting**, separately copy the root-managed signer state in
  `/var/lib/fased-signerd`. It is deliberately outside the Gateway account and
  is not included in the Gateway state archive.

The common migration mistakes are **live database copies**, **profiles**,
**permissions**, and **partial wallet copies**.

## Before you start (what you are migrating)

### 1) Identify your state directory

Most installs use the default:

- **State dir:** `~/.fased/`

But it may be different if you use:

- `--profile <name>` (often becomes `~/.fased-<profile>/`)
- `FASED_STATE_DIR=/some/path`

If you’re not sure, run on the **old** machine:

```bash
fased status
```

Look for mentions of `FASED_STATE_DIR` / profile in the output. If you run multiple gateways, repeat for each profile.

### 2) Identify your workspace

Common defaults:

- `~/.fased/workspace/` (recommended workspace)
- a custom folder you created

Your workspace is where files like `MEMORY.md`, `USER.md`, and `memory/*.md` live.

### 3) Understand what you will preserve

If you copy **both** the state dir and workspace, you keep:

- Gateway configuration (`fased.json`)
- Auth profiles / API keys / OAuth tokens
- Session history + agent state
- Channel state (e.g. WhatsApp login/session)
- Your workspace files (memory, skills notes, etc.)

If you copy **only** the workspace (e.g., via Git), you do **not** preserve:

- sessions
- credentials
- channel logins

Those live under `$FASED_STATE_DIR`.

### 4) Identify the signer layout

- **Local Linux, macOS, or Windows through WSL2:** signer database, master key,
  policies, WebAuthn credentials, caps, and request history are under
  `$FASED_STATE_DIR/wallet` (normally `~/.fased/wallet`). They are included only
  when the entire Local state directory is copied while Gateway and signer are
  stopped.
- **Hosting:** signer database and master key are under
  `/var/lib/fased-signerd`, owned by the dedicated `fased-signer` account. They
  are not readable by the Gateway account and are not in `/home/<app>/.fased`.
- **Local Docker:** use the offline volume snapshot procedure in
  [Docker](/install/docker). Do not replace it with a live volume copy.

The signer database and master key are one recovery unit. The database is not
recoverable without its matching master key; a master key without the matching
database does not restore wallet policy, WebAuthn credentials, durable caps, or
request state. Back up and restore them together.

## Migration steps (recommended)

### Pre-v2 encrypted Local wallets

Do not copy an old encrypted keystore into Node or paste its passphrase into
onboarding. Before a Local/WSL/macOS update, run:

```bash
fased wallet setup --mode local-signer-import --wallet-id agent --role agent
```

The command prints exact native `fased-signerd` import guidance without reading
the key. Prepare the referenced keystore and passphrase as separate `0600`
files, run the native `import-legacy` command, and independently compare the
returned address with `fased wallet status --json` captured before migration.
After it matches:

```bash
fased wallet finalize-legacy-migration --wallet-id agent
fased wallet signer doctor --json
```

Repeat for every old wallet with its permanent role. Only then run
`fased update`. The updater fails before quiescing the old installation while
legacy material is still active; it never guesses a passphrase or silently
widens a deny-all policy.

### Step 0 — Record identity and make an offline backup

Before stopping the old machine, record the installed Fased version and every
wallet's public address:

```bash
fased --version
fased wallet status --json
```

Keep that output with the backup manifest, but never put private key material
in the manifest.

<Tabs>
  <Tab title="Local Linux/macOS/WSL2">
    Stop the Gateway and local signer before copying the bbolt database:

    ```bash
    fased gateway stop
    ```

    Confirm no `fased-signerd` process for this user remains. If it does, stop
    the service that owns it; do not kill it while a signing request is in
    flight. Then archive the entire state directory, not individual wallet
    files:

    ```bash
    # Adjust .fased for the actual FASED_STATE_DIR/profile.
    cd "$HOME"
    umask 077
    tar -czf fased-local-state.tgz .fased
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum fased-local-state.tgz > fased-local-state.tgz.sha256
    else
      shasum -a 256 fased-local-state.tgz > fased-local-state.tgz.sha256
    fi
    ```

    The archive contains API credentials and the signer master key. Encrypt it
    with your organization-approved backup system before it leaves the machine.

  </Tab>

  <Tab title="Hosting">
    Stop Gateway first and signer second, then archive both security domains:

    ```bash
    sudo systemctl stop fased-gateway.service
    sudo systemctl stop fased-signerd.service
    sudo install -d -m 0700 /root/fased-migration
    sudo tar --numeric-owner --acls --xattrs -C / -czf \
      /root/fased-migration/fased-signerd-state.tgz var/lib/fased-signerd
    sudo sha256sum /root/fased-migration/fased-signerd-state.tgz | \
      sudo tee /root/fased-migration/fased-signerd-state.tgz.sha256 >/dev/null
    ```

    Separately archive the complete Gateway state directory and workspace as
    the actual Gateway service user. Find that user and state path from the
    systemd unit instead of assuming a username:

    ```bash
    sudo systemctl show fased-gateway.service -p User -p Environment
    ```

    Set the paths below from that output (these are the maintained defaults),
    verify them, and archive them while both services remain stopped:

    ```bash
    GATEWAY_STATE=/home/app/.fased
    GATEWAY_WORKSPACE=/home/app/.fased/workspace
    sudo test -d "$GATEWAY_STATE"
    sudo test -d "$GATEWAY_WORKSPACE"
    sudo tar --numeric-owner --acls --xattrs -C / -czf \
      /root/fased-migration/fased-gateway-state.tgz "${GATEWAY_STATE#/}"
    sudo tar --numeric-owner --acls --xattrs -C / -czf \
      /root/fased-migration/fased-workspace.tgz "${GATEWAY_WORKSPACE#/}"
    sudo sha256sum \
      /root/fased-migration/fased-gateway-state.tgz \
      /root/fased-migration/fased-workspace.tgz | \
      sudo tee /root/fased-migration/gateway-archives.sha256 >/dev/null
    ```

    If the workspace is inside the state directory, the first archive already
    contains it; the second archive is an intentionally separate recovery
    copy. If your service uses a custom external workspace, replace the path so
    that external directory is not omitted.

    Restart signer first and Gateway second after the offline archives and
    checksums exist:

    ```bash
    sudo systemctl start fased-signerd.service
    sudo systemctl start fased-gateway.service
    ```

    `/root/fased-migration` is only a staging location. Copy it through an
    encrypted, authenticated channel into encrypted backup storage, verify the
    checksum there, and remove the staging copy according to your retention
    policy.

  </Tab>

  <Tab title="Local Docker">
    Follow [Docker offline signer backup and rollback](/install/docker). The
    Docker helper stops Gateway and signer, snapshots signer state, signer
    secrets, Gateway state/config, and workspace, verifies every checksum, and
    records the immutable image identity. A signer-volume-only archive is not
    a complete machine migration.
  </Tab>
</Tabs>

If you have multiple profiles/state directories, repeat the procedure for each
one. Never copy `state.db` or `signerd-v2.db` while its signer is running.

### Step 1 — Install Fased on the new machine

On the **new** machine, install the CLI (and Node if needed):

- See: [Install](/install)

Install the **same exact Fased version** recorded on the old host first. Do not
let a newer signer migrate the only copy of the database. A fresh install may
create empty state; keep it unfunded and stopped before restore.

### Step 2 — Restore Gateway and signer state while stopped

Copy **both**:

- `$FASED_STATE_DIR` (default `~/.fased/`)
- your workspace (default `~/.fased/workspace/`)

Common approaches:

- `scp` the tarballs and extract
- `rsync -a` over SSH
- external drive

For Local, restore the entire state directory while Gateway and signer are
stopped. For Hosting, stop Gateway and signer, restore the Gateway archive as
the Gateway service user, and restore `/var/lib/fased-signerd` as root. Preserve
the archived numeric ownership and modes; the signer directory must remain
owned by `fased-signer` and must not become readable by the Gateway account.

After restoring, ensure:

- Hidden directories were included (e.g. `.fased/`)
- File ownership is correct for the user running the gateway
- `state.db`/`signerd-v2.db` and its matching master key came from the same
  offline snapshot
- no archive was extracted through a symlink or over a running service

### Step 3 — Run Doctor (migrations + service repair)

On the **new** machine:

```bash
fased doctor
fased wallet signer doctor --json
```

Doctor is the “safe boring” command. It repairs services, applies config migrations, and warns about mismatches.

Then:

```bash
fased gateway restart
fased status
fased wallet status --json
```

On Hosting, start and inspect the independent signer before Gateway:

```bash
sudo systemctl start fased-signerd.service
sudo systemctl status fased-signerd.service --no-pager
sudo systemctl start fased-gateway.service
```

Compare every restored public address with the pre-migration manifest before
funding or signing. Verify the acknowledged policy hash, signer network hash,
daily counters, pending/unknown requests, and WebAuthn credential inventory.
When the hostname or WebAuthn origin changes, enroll and test a credential for
the new origin through the signer-admin enrollment flow before retiring the old
host. Keep at least two independently controlled authenticators for a funded
native Vault.

## Common mistakes and fixes

### Profile / state-dir mismatch

If you ran the old gateway with a profile or `FASED_STATE_DIR`, and the new
gateway uses a different one, you will see symptoms like:

- config changes not taking effect
- channels missing / logged out
- empty session history

Fix: run the gateway/service using the **same** profile/state dir you migrated, then rerun:

```bash
fased doctor
```

### Footgun: copying only `fased.json`

`fased.json` is not enough. Many providers store state under:

- `$FASED_STATE_DIR/credentials/`
- `$FASED_STATE_DIR/agents/<agentId>/...`

Always migrate the entire `$FASED_STATE_DIR` folder.

For Hosting wallets, even the entire Gateway state directory is not enough.
You must also migrate the matching offline `/var/lib/fased-signerd` snapshot.

### Footgun: copying a live signer database

bbolt provides transactional state only through the running signer process.
Filesystem-copying its live database can produce a backup that appears present
but is not a valid recovery point. Stop both services in the documented order,
copy database and master key together, verify the archive checksum, then
restart signer before Gateway.

### Footgun: permissions / ownership

If you copied as root or changed users, the gateway may fail to read credentials/sessions.

Fix: ensure the state dir + workspace are owned by the user running the gateway.

### Footgun: migrating between remote/local modes

- If your browser UI or TUI points at a **remote** gateway, the remote host owns the session store + workspace.
- Migrating your laptop won’t move the remote gateway’s state.

If you’re in remote mode, migrate the **gateway host**.

### Footgun: secrets in backups

`$FASED_STATE_DIR` contains secrets (API keys, OAuth tokens, WhatsApp creds). Treat backups like production secrets:

- store encrypted
- avoid sharing over insecure channels
- rotate keys if you suspect exposure

The signer archive is more sensitive: it contains the master key capable of
decrypting wallet keys in the matching database. Use authenticated encryption,
restrict restore access to host administrators, keep an offline copy, and test
restore on an isolated host without broadcasting a transaction.

## Verification checklist

On the new machine, confirm:

- `fased status` shows the gateway running
- Your channels are still connected (e.g. WhatsApp doesn’t require re-pair)
- The dashboard opens and shows existing sessions
- Your workspace files (memory, configs) are present
- Every wallet public address exactly matches the old host
- Signer policy/network hashes and WebAuthn credentials are expected
- A cold restart preserves caps, reservations, and pending/unknown requests
- The old host remains stopped or its wallet policies are deny-all before the
  new host is allowed to sign

## Related

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [Where does Fased store its data?](/help/faq#where-does-fased-store-its-data)
