#!/usr/bin/env bash
set -euo pipefail

phase="${1:-install}"
version="${FASED_FIXTURE_VERSION:?missing fixture version}"
commit="${FASED_FIXTURE_COMMIT:?missing fixture commit}"
gateway_port=18789
gateway_token=fased-hosting-fixture-token
rpc_port=19557
app_home=/home/app
state="$app_home/.fased"
cli="$state/bin/fased"
snapshot=/var/lib/fased-hosting-fixture.json
asset="/artifacts/fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
asset_digest="$(sha256sum "$asset" | awk '{print $1}')"
verified_root="/var/lib/fased-installer/releases/v${version}/${asset_digest}/extract/package"
root_store="$(dirname "$(dirname "$verified_root")")"

mark_stage() {
  printf 'Hosting fixture stage: %s\n' "$1" | tee /tmp/fased-fixture-stage.out
}

wait_for_service() {
  local unit="$1"
  for _ in {1..300}; do
    systemctl is-active --quiet "$unit" && return 0
    sleep 0.1
  done
  journalctl -u "$unit" -n 100 --no-pager >&2 || true
  return 1
}

wait_for_socket() {
  local socket="$1"
  for _ in {1..200}; do
    [[ -S "$socket" ]] && return 0
    sleep 0.1
  done
  echo "socket did not become ready: $socket" >&2
  return 1
}

app_env() {
  printf '%s\n' \
    "HOME=$app_home" \
    "FASED_STATE_DIR=$state" \
    "FASED_CONFIG_PATH=$state/fased.json" \
    "FASED_HOST_PROFILE=hosting" \
    "FASED_GATEWAY_PORT=$gateway_port" \
    "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external" \
    "FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock" \
    "FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock"
}

run_app_cli() {
  local -a environment=()
  mapfile -t environment < <(app_env)
  runuser -u app -- env "${environment[@]}" "$cli" "$@"
}

verify_shared_device_auth() {
  local module_url="file://$state/runtime/current/dist/infra/device-auth-store.js"
  local auth_file="$state/identity/device-auth.json"
  local -a environment=()
  mapfile -t environment < <(app_env)
  runuser -u app -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const store = await import(process.env.FASED_FIXTURE_MODULE_URL);
      store.storeDeviceAuthToken({
        deviceId: "fixture-shared-device",
        role: "operator",
        token: "fixture-operator-token",
      });
    '
  test "$(stat -c '%U:%G:%a' "$auth_file")" = "app:fased-config:660"
  runuser -u fased-gateway -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const store = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const existing = store.loadDeviceAuthToken({
        deviceId: "fixture-shared-device",
        role: "operator",
      });
      if (existing?.token !== "fixture-operator-token") process.exit(91);
      store.storeDeviceAuthToken({
        deviceId: "fixture-shared-device",
        role: "node",
        token: "fixture-node-token",
      });
    '
  test "$(stat -c '%U:%G:%a' "$auth_file")" = "app:fased-config:660"
}

verify_mining_history() {
  runuser -u app -- env \
    HOME="$app_home" \
    USER=app \
    LOGNAME=app \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    FASED_NODE=/usr/local/bin/node \
    "$cli" mining history \
    --url "ws://127.0.0.1:$gateway_port" \
    --token "$gateway_token" \
    --timeout 5000 \
    --json \
    >/tmp/mining-history.json
  jq -e 'type == "object"' /tmp/mining-history.json >/dev/null
}

verify_profileless_config_write() {
  runuser -u app -- env -i \
    HOME="$app_home" \
    USER=app \
    LOGNAME=app \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    FASED_NODE=/usr/local/bin/node \
    "$cli" config set gateway.mode local \
    >/tmp/profileless-config-write.out
  test "$(stat -c '%U:%G:%a' "$state/fased.json")" = "app:fased-config:660"
  systemctl restart fased-gateway.service
  verify_runtime >/tmp/profileless-config-health.json
}

verify_shared_federation_state() {
  local module_url="file://$state/runtime/current/dist/federation/access-token.js"
  local token_file="$state/federation/access-token.json"
  local -a environment=()
  mapfile -t environment < <(app_env)
  runuser -u app -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const federation = await import(process.env.FASED_FIXTURE_MODULE_URL);
      await federation.persistFederationAccessToken({
        tokenId: "fixture-federation-token",
        nodeId: "fixture-node",
        handle: "@fixture@fased.test",
        issuedAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2027-07-26T00:00:00.000Z",
        scopes: ["federation.read"],
        signature: "fixture-signature",
      });
    '
  test "$(stat -c '%U:%G:%a' "$state/federation")" = "app:fased-config:2770"
  test "$(stat -c '%U:%G:%a' "$token_file")" = "app:fased-config:660"
  runuser -u fased-gateway -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const federation = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const existing = await federation.loadPersistedFederationToken();
      if (existing?.tokenId !== "fixture-federation-token") process.exit(93);
      await federation.persistFederationAccessToken({ ...existing, hostedState: "ready" });
    '
  test "$(stat -c '%U:%G:%a' "$token_file")" = "fased-gateway:fased-config:660"
  runuser -u app -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const federation = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const existing = await federation.loadPersistedFederationToken();
      if (existing?.hostedState !== "ready") process.exit(94);
    '
}

verify_shared_wallet_registry() {
  local module_url="file://$state/runtime/current/dist/wallet/wallet-provider-registry.js"
  local registry="$state/wallet/provider-registry.v1.json"
  local -a environment=()
  mapfile -t environment < <(app_env)
  test "$(stat -c '%U:%G:%a' "$state/wallet")" = "app:fased-config:2770"
  test "$(stat -c '%U:%G:%a' "$registry")" = "app:fased-config:660"
  runuser -u fased-gateway -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const registry = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const wallets = registry.readWalletProviderRegistry().wallets;
      if (!wallets.some((wallet) => wallet.id === "agent")) process.exit(92);
    '
}

verify_wallet() {
  local wallet_id="$1"
  runuser -u app -- /opt/fased/signer/fased-signerd \
    admin wallet readiness \
    --operator-socket /run/fased-signerd/operator.sock \
    --wallet-id "$wallet_id"
}

install_fixture_command_shims() {
  mv /usr/local/bin/node /usr/local/bin/node-real
  cat >/usr/local/bin/node <<'EOF_NODE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "/opt/fased/host-controller/current/fased-host-updater.mjs" ]]; then
  exec /usr/local/bin/node-real /repo/scripts/docker/hosting-systemd/updater-wrapper.mjs "${@:2}"
fi
exec /usr/local/bin/node-real "$@"
EOF_NODE
  chmod 0755 /usr/local/bin/node

  cat >/usr/local/bin/git <<'EOF_GIT'
#!/usr/bin/env bash
set -euo pipefail
version="$(cat /artifacts/fixture-version)"
commit="$(cat /artifacts/fixture-commit)"
if [[ "${1:-}" == "clone" ]]; then
  destination="${!#}"
  mkdir -p "$destination"
  tar \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=.pnpm-store \
    --exclude=dist \
    --exclude=ui/node_modules \
    --exclude=ui/dist \
    -C /repo -cf - . | tar -C "$destination" -xf -
  exit 0
fi
if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
  printf '%s\n' "$commit"
  exit 0
fi
exec /usr/bin/git "$@"
EOF_GIT
  chmod 0755 /usr/local/bin/git

  cat >/usr/local/bin/curl <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail
arguments=("$@")
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o|--output)
      output="${2:-}"
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [[ "$url" == "https://api.github.com/repos/fased-ai/fased/releases/latest" ]]; then
  printf '{"tag_name":"v%s"}\n' "$(cat /artifacts/fixture-version)"
  exit 0
fi
if [[ "$url" == https://github.com/fased-ai/fased/releases/download/* ]]; then
  source="/artifacts/${url##*/}"
  [[ -f "$source" ]] || {
    echo "missing fixture release asset: ${url##*/}" >&2
    exit 22
  }
  if [[ -n "$output" ]]; then
    cp "$source" "$output"
  else
    cat "$source"
  fi
  exit 0
fi
exec /usr/bin/curl "${arguments[@]}"
EOF_CURL
  chmod 0755 /usr/local/bin/curl

  cat >/usr/local/bin/gh <<'EOF_GH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"attestation verify"* ]]; then
  exit 0
fi
printf 'gh version 2.99.0 fixture\n'
EOF_GH
  chmod 0755 /usr/local/bin/gh

  cat >/usr/local/bin/tailscale <<'EOF_TAILSCALE'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  ip)
    printf '100.64.0.10\n'
    ;;
  status)
    if [[ "${2:-}" == "--json" ]]; then
      printf '{"BackendState":"Running","Self":{"DNSName":"fixture.tailnet.ts.net."}}\n'
    else
      printf '100.64.0.10 fixture fixture@ linux active\n'
    fi
    ;;
  serve)
    if [[ "${2:-}" == "status" ]]; then
      cat <<'EOF_STATUS'
https://fixture.tailnet.ts.net
|-- / proxy http://127.0.0.1:18789
EOF_STATUS
    else
      cat <<'EOF_SERVE'
Available within your tailnet:
https://fixture.tailnet.ts.net/
|-- proxy http://127.0.0.1:18789
Serve started and running in the background.
EOF_SERVE
    fi
    ;;
  up|logout|set|ping)
    exit 0
    ;;
  *)
    echo "unsupported fixture tailscale command: $*" >&2
    exit 64
    ;;
esac
EOF_TAILSCALE
  chmod 0755 /usr/local/bin/tailscale

  if [[ -x /usr/bin/apt-get ]]; then
    cat >/usr/local/bin/apt-get <<'EOF_PACKAGE_MANAGER'
#!/usr/bin/env bash
exit 0
EOF_PACKAGE_MANAGER
    chmod 0755 /usr/local/bin/apt-get
    cat >/usr/local/bin/ufw <<'EOF_UFW'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "status" ]]; then
  printf 'Status: inactive\n'
fi
exit 0
EOF_UFW
    chmod 0755 /usr/local/bin/ufw
  else
    cat >/usr/local/bin/dnf <<'EOF_PACKAGE_MANAGER'
#!/usr/bin/env bash
exit 0
EOF_PACKAGE_MANAGER
    chmod 0755 /usr/local/bin/dnf
    cat >/usr/local/bin/firewall-cmd <<'EOF_FIREWALL'
#!/usr/bin/env bash
exit 0
EOF_FIREWALL
    chmod 0755 /usr/local/bin/firewall-cmd
  fi
}

install_fixture_system_services() {
  cat >/etc/systemd/system/fased-fixture-noop.service <<'EOF_NOOP'
[Unit]
Description=Fased fixture no-op service

[Service]
Type=oneshot
ExecStart=/bin/true
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF_NOOP
  for service in tailscaled ssh sshd fail2ban unattended-upgrades firewalld; do
    ln -sfn fased-fixture-noop.service "/etc/systemd/system/${service}.service"
  done
  for timer in apt-daily apt-daily-upgrade dnf-automatic dnf5-automatic yum-cron; do
    cat >"/etc/systemd/system/${timer}.timer" <<EOF_TIMER
[Unit]
Description=Fased fixture ${timer} timer

[Timer]
OnBootSec=1h
Unit=fased-fixture-noop.service

[Install]
WantedBy=timers.target
EOF_TIMER
  done
  install -d -m 0755 /etc/systemd/system/fased-gateway.service.d
  cat >/etc/systemd/system/fased-gateway.service.d/99-fixture-network.conf <<'EOF_GATEWAY'
[Service]
Environment=FASED_DISABLE_BONJOUR=1
EOF_GATEWAY
  systemctl daemon-reload
}

install_fixture_rpc() {
  install -d -m 0755 -o root -g root /usr/local/libexec
  cat >/usr/local/libexec/fased-fixture-solana-rpc.mjs <<'EOF_RPC'
import http from "node:http";
const port = Number(process.env.FASED_FIXTURE_RPC_PORT);
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // pragma: allowlist secret
http.createServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch {}
    let result;
    if (input.method === "getGenesisHash") result = genesis;
    else if (input.method === "getBalance") result = { context: { slot: 1 }, value: 3_000_000_000 };
    else if (input.method === "getLatestBlockhash") {
      result = { context: { slot: 1 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
    } else if (input.method === "getTokenAccountsByOwner") {
      result = { context: { slot: 1 }, value: [] };
    } else if (input.method === "getAccountInfo") {
      result = { context: { slot: 1 }, value: null };
    } else result = null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id ?? 1, result }));
  });
}).listen(port, "127.0.0.1");
EOF_RPC
  cat >/etc/systemd/system/fased-fixture-solana-rpc.service <<EOF_RPC_UNIT
[Unit]
Description=Fased fixture Solana RPC

[Service]
Type=simple
Environment=FASED_FIXTURE_RPC_PORT=$rpc_port
ExecStart=/usr/local/bin/node /usr/local/libexec/fased-fixture-solana-rpc.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF_RPC_UNIT
  systemctl daemon-reload
  systemctl enable --now fased-fixture-solana-rpc.service
  wait_for_service fased-fixture-solana-rpc.service
}

prepare_verified_bundle() {
  install -d -m 0700 -o root -g root "$(dirname "$root_store")"
  install -d -m 0700 -o root -g root "$root_store/extract"
  tar -xzf "$asset" -C "$root_store/extract"
  install -d -m 0755 -o root -g root "$root_store/verified-assets"
  install -m 0755 -o root -g root /artifacts/fased-signerd-linux-amd64 \
    "$root_store/verified-assets/fased-signerd"
  local signer_sha=""
  local manifest_sha=""
  signer_sha="$(sha256sum "$root_store/verified-assets/fased-signerd" | awk '{print $1}')"
  manifest_sha="$(sha256sum /artifacts/fased-hosted-release-v2.json | awk '{print $1}')"
  printf 'version=%s\nsha256=%s\nsigner_sha256=%s\nrelease_manifest_sha256=%s\ncommit=%s\n' \
    "$version" "$asset_digest" "$signer_sha" "$manifest_sha" "$commit" \
    >"$verified_root/.fased-hosting-bundle-verified"
  chown -R root:root "$root_store"
  chmod -R go-w "$root_store"
  chmod 0600 "$verified_root/.fased-hosting-bundle-verified"
}

run_hosting_installer() {
  local selector="$1"
  FASED_KEEP_BOOTSTRAP_CHECKOUT=1 \
    bash "$verified_root/install.sh" \
      "$selector" \
      --release "v${version}" \
      --update-channel beta \
      --verified-hosting-bundle "$verified_root" \
      -- \
      --non-interactive \
      --accept-risk \
      --auth-choice skip \
      --gateway-token "$gateway_token" \
      --wallet-enabled \
      --wallet-providers local-socket-signer \
      --wallet-default-provider local-socket-signer \
      --wallet-chains solana \
      --skip-channels \
      --skip-skills \
      --skip-ui \
      --fast-health
}

verify_runtime() {
  wait_for_service fased-host-updater.service
  wait_for_service fased-signerd.service
  wait_for_service fased-gateway.service
  wait_for_socket /run/fased-host-updater/request.sock
  wait_for_socket /run/fased-signerd/app.sock
  wait_for_socket /run/fased-signerd/operator.sock
  runuser -u fased-gateway -- /usr/local/bin/node --input-type=module --eval \
    'const { probeSignerV2 } = await import("file:///usr/local/libexec/fased-host-updater.mjs"); await probeSignerV2(undefined, "/run/fased-signerd/app.sock");'
  run_app_cli health --json --timeout 5000
  ss -ltn | grep -Eq "127\\.0\\.0\\.1:${gateway_port}[[:space:]]"
  if ss -ltn | grep -Eq "(0\\.0\\.0\\.0|\\[::\\]):${gateway_port}[[:space:]]"; then
    echo "Hosting Gateway is publicly bound." >&2
    exit 1
  fi
}

if [[ "$phase" == "verify-reboot" ]]; then
  [[ -f "$snapshot" ]]
  verify_runtime >/tmp/reboot-health.json
  verify_wallet agent >/tmp/reboot-agent.json
  verify_wallet vault >/tmp/reboot-vault.json
  jq -e '.ready == true and .role == "agent"' /tmp/reboot-agent.json >/dev/null
  jq -e '.ready == true and .role == "vault"' /tmp/reboot-vault.json >/dev/null
  test "$(jq -S -c . /tmp/reboot-agent.json | sha256sum | awk '{print $1}')" = \
    "$(jq -r .agentReadinessSha256 "$snapshot")"
  test "$(jq -S -c . /tmp/reboot-vault.json | sha256sum | awk '{print $1}')" = \
    "$(jq -r .vaultReadinessSha256 "$snapshot")"
  test "$(sha256sum /var/lib/fased-signerd/master.key | awk '{print $1}')" = \
    "$(jq -r .masterKeySha256 "$snapshot")"
  test "$(sha256sum "$state/wallet/provider-registry.v1.json" | awk '{print $1}')" = \
    "$(jq -r .registrySha256 "$snapshot")"
  printf 'Hosting reboot fixture passed: %s\n' "$version"
  exit 0
fi

[[ "$phase" == "install" ]] || {
  echo "usage: fased-hosting-systemd-fixture install|verify-reboot" >&2
  exit 64
}

install_fixture_command_shims
install_fixture_system_services
install_fixture_rpc
prepare_verified_bundle

mark_stage fresh-install
run_hosting_installer --hosting
mark_stage fresh-runtime-verification
verify_runtime >/tmp/fresh-health.json
verify_shared_device_auth
verify_mining_history
verify_shared_federation_state
verify_profileless_config_write

run_app_cli wallet setup \
  --mode local-signer-create \
  --wallet-id agent \
  --wallet-name Agent \
  --role agent \
  --rpc-url "http://127.0.0.1:$rpc_port" \
  --non-interactive \
  --json \
  >/tmp/agent-create.json
run_app_cli wallet setup \
  --mode local-signer-create \
  --wallet-id vault \
  --wallet-name Vault \
  --role vault \
  --rpc-url "http://127.0.0.1:$rpc_port" \
  --non-interactive \
  --json \
  >/tmp/vault-create.json
verify_shared_wallet_registry
verify_wallet agent >/tmp/fresh-agent.json
verify_wallet vault >/tmp/fresh-vault.json
jq -e '.ready == true and .role == "agent"' /tmp/fresh-agent.json >/dev/null
jq -e '.ready == true and .role == "vault"' /tmp/fresh-vault.json >/dev/null
runuser -u app -- /opt/fased/signer/fased-signerd \
  admin wallet balance \
  --operator-socket /run/fased-signerd/operator.sock \
  --wallet-id agent \
  >/tmp/agent-balance.json
jq -e '.balance == "3000000000" and .unit == "lamports"' /tmp/agent-balance.json >/dev/null

mark_stage repair
chmod 0600 "$state/identity/device-auth.json"
run_hosting_installer --repair-hosting
verify_runtime >/tmp/repair-health.json
test "$(stat -c '%U:%G:%a' "$state/identity/device-auth.json")" = "app:fased-config:660"
verify_shared_device_auth
verify_shared_federation_state
verify_wallet agent >/tmp/repair-agent.json
verify_wallet vault >/tmp/repair-vault.json
jq -e '.ready == true and .role == "agent"' /tmp/repair-agent.json >/dev/null
jq -e '.ready == true and .role == "vault"' /tmp/repair-vault.json >/dev/null

mark_stage injected-activation-failure
chmod 0600 "$state/identity/device-auth.json"
chmod 0644 /opt/fased/signer/fased-signerd
/usr/local/bin/node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --prepare-only \
  >/tmp/failure-prepare.json
jq -e '.changed == true and .phase == "prepared"' /tmp/failure-prepare.json >/dev/null
printf 'Prepare reconciliation result: '
cat /tmp/failure-prepare.json
mark_stage injected-activation-permission-check
device_auth_metadata="$(stat -c '%U:%G:%a' "$state/identity/device-auth.json" 2>&1 || true)"
printf 'Device auth metadata after prepare: %s\n' "$device_auth_metadata" |
  tee /tmp/device-auth-metadata.out
test "${device_auth_metadata#*:}" = "fased-config:660"
mark_stage injected-activation-mining-check
verify_mining_history
mark_stage injected-activation-execution
chmod 0755 /opt/fased/signer/fased-signerd
transaction_id="$(jq -er .transactionId /var/lib/fased-host-updater/ctl-transaction.json)"
printf '#!/usr/bin/env bash\nexit 91\n' \
  >"/opt/fased/signer/.fased-signerd.candidate-${transaction_id}"
chmod 0755 "/opt/fased/signer/.fased-signerd.candidate-${transaction_id}"
set +e
/usr/local/bin/node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --activate-only \
  >/tmp/failure-activate.out 2>/tmp/failure-activate.err
failure_status=$?
set -e
test "$failure_status" -ne 0
test ! -e /var/lib/fased-host-updater/ctl-transaction.json
wait_for_service fased-signerd.service
verify_wallet agent >/tmp/rollback-agent.json
verify_wallet vault >/tmp/rollback-vault.json
jq -e '.ready == true and .role == "agent"' /tmp/rollback-agent.json >/dev/null
jq -e '.ready == true and .role == "vault"' /tmp/rollback-vault.json >/dev/null

mark_stage retry
chmod 0644 /opt/fased/signer/fased-signerd
/usr/local/bin/node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --prepare-only \
  >/tmp/retry-prepare.json
jq -e '.changed == true and .phase == "prepared"' /tmp/retry-prepare.json >/dev/null
transaction_id="$(jq -er .transactionId /var/lib/fased-host-updater/ctl-transaction.json)"
chmod 0755 /opt/fased/signer/fased-signerd
/usr/local/bin/node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --activate-only \
  >/tmp/retry-activate.json
runuser -u app -- /usr/local/bin/node /usr/local/bin/fased-hosting-updater-request \
  authorizeGatewayRelease "$transaction_id" "$version" \
  >/tmp/retry-authorize.json
jq -e '.phase == "gateway-authorized"' /tmp/retry-authorize.json >/dev/null
verify_runtime >/tmp/retry-health.json
/usr/local/bin/node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --commit-only \
  >/tmp/retry-commit.json
jq -e '.phase == "committed"' /tmp/retry-commit.json >/dev/null

mark_stage service-restart
systemctl restart fased-host-updater.service
wait_for_service fased-host-updater.service
systemctl restart fased-signerd.service
wait_for_service fased-signerd.service
systemctl restart fased-gateway.service
verify_runtime >/tmp/restart-health.json

verify_wallet agent >/tmp/pre-reboot-agent.json
verify_wallet vault >/tmp/pre-reboot-vault.json
mark_stage reboot-snapshot
agent_readiness_sha="$(jq -S -c . /tmp/pre-reboot-agent.json | sha256sum | awk '{print $1}')"
vault_readiness_sha="$(jq -S -c . /tmp/pre-reboot-vault.json | sha256sum | awk '{print $1}')"
master_key_sha="$(sha256sum /var/lib/fased-signerd/master.key | awk '{print $1}')"
registry_sha="$(sha256sum "$state/wallet/provider-registry.v1.json" | awk '{print $1}')"
jq -n \
  --arg agentReadinessSha256 "$agent_readiness_sha" \
  --arg vaultReadinessSha256 "$vault_readiness_sha" \
  --arg masterKeySha256 "$master_key_sha" \
  --arg registrySha256 "$registry_sha" \
  '{
    agentReadinessSha256: $agentReadinessSha256,
    vaultReadinessSha256: $vaultReadinessSha256,
    masterKeySha256: $masterKeySha256,
    registrySha256: $registrySha256
  }' >"$snapshot"
chmod 0600 "$snapshot"

printf 'Hosting fresh, repair, rollback, retry, Gateway, and wallet fixture passed: %s\n' "$version"
