#!/usr/bin/env bash
set -euo pipefail

phase="${1:-install}"
version="${FASED_FIXTURE_VERSION:?missing fixture version}"
commit="${FASED_FIXTURE_COMMIT:?missing fixture commit}"
predecessor_version=0.1.75
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
release_assets=/var/lib/fased-hosting-fixture/release-assets
fixture_tls=/var/lib/fased-hosting-fixture/tls

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

lifecycle_socket_requests() {
  local socket_path="$1"
  local operation="$2"
  local transaction_id="$3"
  local release_version="$4"
  local request_count="$5"
  local output_path="$6"
  env \
    FASED_FIXTURE_SOCKET_PATH="$socket_path" \
    FASED_FIXTURE_OPERATION="$operation" \
    FASED_FIXTURE_TRANSACTION_ID="$transaction_id" \
    FASED_FIXTURE_RELEASE_VERSION="$release_version" \
    FASED_FIXTURE_REQUEST_COUNT="$request_count" \
    /usr/local/bin/node --input-type=module >"$output_path" <<'EOF_LIFECYCLE_REQUEST'
import net from "node:net";

const socketPath = process.env.FASED_FIXTURE_SOCKET_PATH;
const operation = process.env.FASED_FIXTURE_OPERATION;
const transactionId = process.env.FASED_FIXTURE_TRANSACTION_ID;
const version = process.env.FASED_FIXTURE_RELEASE_VERSION;
const requestCount = Number(process.env.FASED_FIXTURE_REQUEST_COUNT);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestOnce() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(120_000);
    let body = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ schemaVersion: 2, op: operation, transactionId, version })}\n`);
    });
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0 || settled) return;
      try {
        settled = true;
        const response = JSON.parse(body.slice(0, newline));
        socket.destroy();
        resolve(response);
      } catch (error) {
        fail(error);
      }
    });
    socket.once("timeout", () => fail(new Error(`${operation} timed out`)));
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error(`${operation} closed without a response`));
    });
  });
}

async function requestWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      return await requestOnce();
    } catch (error) {
      lastError = error;
      if (!new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(error?.code)) {
        throw error;
      }
      await delay(100);
    }
  }
  throw lastError;
}

const responses = [];
for (let index = 0; index < requestCount; index += 1) {
  responses.push(await requestWithRetry());
  if (index + 1 < requestCount) await delay(500);
}
process.stdout.write(`${JSON.stringify(responses)}\n`);
EOF_LIFECYCLE_REQUEST
}

verify_supervised_controller_a_to_b() {
  local controller_state=/var/lib/fased-host-updater
  local controller_root=/opt/fased/host-controller
  local controller_unit=fased-host-controller.service
  local supervisor_unit=fased-host-updater.service
  local public_socket=/run/fased-host-updater/request.sock
  local private_socket=/run/fased-host-controller/controller.sock
  local target_generation=""
  local predecessor_generation="$controller_root/releases/v$predecessor_version"
  local supervisor_identity="$controller_state/supervisor/controller-version.json"
  local product_identity="$controller_state/controller-version.json"
  local preservation_manifest=/tmp/hosting-controller-a-to-b-preservation.sha256
  local transaction_id=""
  local status_transaction_id=""
  local selection_digest=""
  local selection_receipt=""
  local target_manifest_sha=""
  local target_server_sha=""
  local target_client_sha=""
  local controller_pid=""
  local supervisor_pid=""
  local request_pid=""
  local controller_drop_in="/etc/systemd/system/$controller_unit.d"
  local supervisor_drop_in="/etc/systemd/system/$supervisor_unit.d"
  local interruption_marker="$controller_state/fixture-controller-interruption"
  local interruption_script=/usr/local/libexec/fased-fixture-controller-block
  local interruption_override="$controller_drop_in/98-fixture-block.conf"
  local failure_marker="$controller_state/fixture-controller-restart-failure"
  local failure_script=/usr/local/libexec/fased-fixture-controller-fail-once
  local failure_override="$controller_drop_in/99-fixture-fail-once.conf"

  printf 'Hosting generated-systemd controller transition stage: preflight\n'
  target_generation="$(readlink -f "$controller_root/current")"
  test "$target_generation" = "$controller_root/releases/v$version"
  test -f "$supervisor_identity"
  test -d "$controller_drop_in"
  test -d "$supervisor_drop_in"
  if find "$controller_drop_in" "$supervisor_drop_in" \
    -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "Hosting generated-systemd protected unit drop-in boundary is not empty" >&2
    return 1
  fi

  printf 'Hosting generated-systemd controller transition stage: preservation-state\n'
  # The controller-only transition must not mutate product state. Quiesce the
  # live Gateway while taking and checking exact hashes so its legitimate
  # device/federation background writes cannot be misclassified as updater
  # corruption. Product activation, restart, and reboot are exercised below.
  systemctl stop fased-gateway.service
  test "$(systemctl is-active fased-gateway.service 2>/dev/null || true)" = "inactive"
  install -d -m 2770 -o app -g fased-config \
    "$state/sat-mining/wallets/agent" "$state/extensions"
  runuser -u app -- env FASED_FIXTURE_MINING_LEDGER="$state/sat-mining/wallets/agent/mining.sqlite" \
    /usr/local/bin/node --input-type=module <<'EOF_MINING_LEDGER'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.env.FASED_FIXTURE_MINING_LEDGER);
try {
  database.exec(
    "CREATE TABLE IF NOT EXISTS mining_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "INSERT OR REPLACE INTO mining_meta(key,value) VALUES('schema_version','1'),('history_revision','7');",
  );
} finally {
  database.close();
}
EOF_MINING_LEDGER
  chown app:fased-config "$state/sat-mining/wallets/agent/mining.sqlite"
  chmod 0660 "$state/sat-mining/wallets/agent/mining.sqlite"
  printf '{"schemaVersion":1,"rpc":"fixture-rpc","policy":"agent"}\n' \
    >"$state/wallet/fixture-policy-rpc.json"
  printf '{"schemaVersion":1,"enabled":["fixture"]}\n' \
    >"$state/extensions/fixture-plugin-state.json"
  chown app:fased-config \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"
  chmod 0660 \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"
  sha256sum \
    "$state/wallet/provider-registry.v1.json" \
    "$state/wallet/fixture-policy-rpc.json" \
    /var/lib/fased-signerd/state.db \
    /var/lib/fased-signerd/master.key \
    "$state/sat-mining/wallets/agent/mining.sqlite" \
    "$state/identity/device-auth.json" \
    "$state/federation/access-token.json" \
    "$state/extensions/fixture-plugin-state.json" \
    >"$preservation_manifest"

  printf 'Hosting generated-systemd controller transition stage: predecessor-activation\n'
  systemctl stop "$supervisor_unit" "$controller_unit"
  rm -rf -- "$predecessor_generation"
  install -d -m 0755 -o root -g root "$predecessor_generation"
  install -m 0644 -o root -g root \
    "$target_generation/fased-host-updater.mjs" \
    "$predecessor_generation/fased-host-updater.mjs"
  install -m 0644 -o root -g root \
    "$target_generation/fased-host-updaterctl.mjs" \
    "$predecessor_generation/fased-host-updaterctl.mjs"
  jq --arg version "$predecessor_version" '.version = $version' "$supervisor_identity" \
    >/tmp/hosting-controller-predecessor-identity.json
  install -m 0600 -o root -g root \
    /tmp/hosting-controller-predecessor-identity.json "$supervisor_identity"
  install -m 0600 -o root -g root \
    /tmp/hosting-controller-predecessor-identity.json "$product_identity"
  ln -s "$predecessor_generation" "$controller_root/current.fixture"
  mv -Tf "$controller_root/current.fixture" "$controller_root/current"
  systemctl start "$controller_unit" "$supervisor_unit"
  wait_for_service "$controller_unit"
  wait_for_service "$supervisor_unit"
  wait_for_socket "$private_socket"
  wait_for_socket "$public_socket"
  status_transaction_id="$(/usr/local/bin/node -e 'process.stdout.write(crypto.randomUUID())')"
  lifecycle_socket_requests \
    "$private_socket" controllerStatus "$status_transaction_id" "$predecessor_version" 1 \
    /tmp/hosting-controller-predecessor-status.json
  jq -e --arg version "$predecessor_version" \
    'length == 1 and .[0].ok == true and .[0].controllerVersion == $version' \
    /tmp/hosting-controller-predecessor-status.json >/dev/null

  printf 'Hosting generated-systemd controller transition stage: interruption-recovery\n'
  cat >"$interruption_script" <<EOF_CONTROLLER_BLOCK
#!/usr/bin/env bash
set -euo pipefail
while [[ -f "$interruption_marker" ]]; do sleep 0.1; done
EOF_CONTROLLER_BLOCK
  chmod 0755 "$interruption_script"
  cat >"$interruption_override" <<EOF_CONTROLLER_BLOCK_OVERRIDE
[Service]
ExecStartPre=$interruption_script
EOF_CONTROLLER_BLOCK_OVERRIDE
  chmod 0644 "$interruption_override"
  touch "$interruption_marker"
  systemctl daemon-reload
  transaction_id="$(/usr/local/bin/node -e 'process.stdout.write(crypto.randomUUID())')"
  lifecycle_socket_requests \
    "$public_socket" updateController "$transaction_id" "$version" 1 \
    /tmp/hosting-controller-interrupted.json &
  request_pid=$!
  for _ in {1..300}; do
    if [[ -f "$controller_state/supervisor/controller-transaction.json" ]] && \
      [[ "$(readlink -f "$controller_root/current")" == "$target_generation" ]]; then
      break
    fi
    sleep 0.1
  done
  test -f "$controller_state/supervisor/controller-transaction.json"
  test "$(readlink -f "$controller_root/current")" = "$target_generation"
  supervisor_pid="$(systemctl show -p MainPID --value "$supervisor_unit")"
  test "$supervisor_pid" -gt 1
  kill -KILL "$supervisor_pid"
  kill "$request_pid" 2>/dev/null || true
  wait "$request_pid" 2>/dev/null || true
  rm -f -- "$interruption_marker" "$interruption_override" "$interruption_script"
  systemctl daemon-reload
  systemctl reset-failed "$controller_unit" "$supervisor_unit" || true
  wait_for_service "$controller_unit"
  wait_for_service "$supervisor_unit"
  wait_for_socket "$private_socket"
  wait_for_socket "$public_socket"
  test "$(readlink -f "$controller_root/current")" = "$predecessor_generation"
  test "$(jq -r .version "$supervisor_identity")" = "$predecessor_version"
  test ! -e "$controller_state/supervisor/controller-transaction.json"
  sha256sum --check --status "$preservation_manifest"

  printf 'Hosting generated-systemd controller transition stage: injected-rollback\n'
  cat >"$failure_script" <<EOF_CONTROLLER_FAIL_ONCE
#!/usr/bin/env bash
set -euo pipefail
marker=$failure_marker
if [[ -f "\$marker" ]]; then
  rm -f -- "\$marker"
  exit 72
fi
EOF_CONTROLLER_FAIL_ONCE
  chmod 0755 "$failure_script"
  cat >"$failure_override" <<EOF_CONTROLLER_FAILURE_OVERRIDE
[Service]
ExecStartPre=$failure_script
EOF_CONTROLLER_FAILURE_OVERRIDE
  chmod 0644 "$failure_override"
  touch "$failure_marker"
  systemctl daemon-reload
  transaction_id="$(/usr/local/bin/node -e 'process.stdout.write(crypto.randomUUID())')"
  lifecycle_socket_requests \
    "$public_socket" updateController "$transaction_id" "$version" 1 \
    /tmp/hosting-controller-transition-failure.json
  jq -e \
    'length == 1 and .[0].ok == false and (.[0].error | contains("controller promotion failed and was restored"))' \
    /tmp/hosting-controller-transition-failure.json >/dev/null
  wait_for_service "$controller_unit"
  test "$(readlink -f "$controller_root/current")" = "$predecessor_generation"
  test "$(jq -r .version "$supervisor_identity")" = "$predecessor_version"
  test ! -e "$controller_state/supervisor/controller-transaction.json"
  test ! -e "$failure_marker"
  sha256sum --check --status "$preservation_manifest"

  printf 'Hosting generated-systemd controller transition stage: same-command-retry\n'
  rm -f -- "$failure_override" "$failure_script"
  systemctl daemon-reload
  systemctl reset-failed "$controller_unit"
  lifecycle_socket_requests \
    "$public_socket" updateController "$transaction_id" "$version" 2 \
    /tmp/hosting-controller-transition-success.json
  jq -e --arg version "$version" \
    'length == 2 and .[0].ok == true and .[0].version == $version and .[0].controllerChanged == true and .[1].ok == true and .[1].version == $version and .[1].controllerChanged == false and (.[1].controllerInstanceId | type == "string") and (.[1].selectionDigest | test("^[a-f0-9]{64}$"))' \
    /tmp/hosting-controller-transition-success.json >/dev/null
  wait_for_service "$controller_unit"
  wait_for_service "$supervisor_unit"
  test "$(readlink -f "$controller_root/current")" = "$target_generation"
  test "$(jq -r .version "$supervisor_identity")" = "$version"
  test -d "$predecessor_generation"
  test ! -L "$predecessor_generation"
  test ! -e "$controller_state/supervisor/controller-transaction.json"
  sha256sum --check --status "$preservation_manifest"

  printf 'Hosting generated-systemd controller transition stage: receipt-binding\n'
  selection_digest="$(jq -er '.[1].selectionDigest' /tmp/hosting-controller-transition-success.json)"
  selection_receipt="$controller_state/supervisor/controller-selections/$transaction_id/$selection_digest.json"
  target_manifest_sha="$(sha256sum /artifacts/fased-hosted-release-v2.json | awk '{print $1}')"
  target_server_sha="$(sha256sum "$target_generation/fased-host-updater.mjs" | awk '{print $1}')"
  target_client_sha="$(sha256sum "$target_generation/fased-host-updaterctl.mjs" | awk '{print $1}')"
  jq -e \
    --arg transaction "$transaction_id" \
    --arg version "$version" \
    --arg commit "$commit" \
    --arg manifest "$target_manifest_sha" \
    --arg server "$target_server_sha" \
    --arg client "$target_client_sha" \
    --arg instance "$(jq -er '.[1].controllerInstanceId' /tmp/hosting-controller-transition-success.json)" \
    --arg selection "$selection_digest" \
    '.transactionId == $transaction and .version == $version and .releaseCommit == $commit and .targetManifestSha256 == $manifest and .controllerServerSha256 == $server and .controllerClientSha256 == $client and .controllerInstanceId == $instance and .selectionDigest == $selection and .protocolCapabilities == {"controllerProtocol":2,"requestSchema":2,"supervisorProtocol":1}' \
    "$selection_receipt" >/dev/null
  test "$(cat "$controller_state/supervisor/controller-selections/$transaction_id/current")" = \
    "$selection_digest"

  printf 'Hosting generated-systemd controller transition stage: namespace-denial\n'
  controller_pid="$(systemctl show -p MainPID --value "$controller_unit")"
  test "$controller_pid" -gt 1
  if nsenter --target "$controller_pid" --mount -- \
    mkdir "$controller_root/fixture-forbidden-controller-write" 2>/tmp/hosting-controller-write.err; then
    echo "Hosting target controller wrote its supervisor-owned generation tree" >&2
    return 1
  fi
  if nsenter --target "$controller_pid" --mount -- \
    touch "$controller_drop_in/fixture-forbidden.conf" 2>/tmp/hosting-controller-drop-in-write.err; then
    echo "Hosting target controller wrote its own systemd drop-in" >&2
    return 1
  fi
  if nsenter --target "$controller_pid" --mount -- \
    touch "$supervisor_drop_in/fixture-forbidden.conf" 2>/tmp/hosting-supervisor-drop-in-write.err; then
    echo "Hosting target controller wrote the supervisor systemd drop-in" >&2
    return 1
  fi
  test ! -e "$controller_root/fixture-forbidden-controller-write"
  test ! -e "$controller_drop_in/fixture-forbidden.conf"
  test ! -e "$supervisor_drop_in/fixture-forbidden.conf"
  systemctl start fased-gateway.service
  verify_runtime >/tmp/hosting-controller-a-to-b-health.json
  printf 'Hosting generated-systemd supervised controller A-to-B lifecycle passed\n'
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
    --exclude=.artifacts \
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

prepare_candidate_release_transport() {
  install -d -m 0755 -o root -g root \
    "$release_assets" "$fixture_tls" /usr/local/libexec
  install -m 0755 /artifacts/install.sh "$release_assets/install.sh"
  install -m 0755 /artifacts/fased-lifecycle-supervisor.mjs \
    "$release_assets/fased-lifecycle-supervisor.mjs"
  install -m 0755 /artifacts/fased-host-updater.mjs \
    "$release_assets/fased-host-updater.mjs"
  install -m 0755 /artifacts/fased-host-updaterctl.mjs \
    "$release_assets/fased-host-updaterctl.mjs"
  install -m 0755 /artifacts/fased-privileged-release-evidence.mjs \
    "$release_assets/fased-privileged-release-evidence.mjs"
  install -m 0644 /artifacts/fased-hosted-release-v2.json \
    "$release_assets/fased-hosted-release-v2.json"
  install -m 0644 \
    /artifacts/fased-hosted-app-v2-linux-x64-v${version}.tar.gz \
    "$release_assets/fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
  install -m 0644 \
    /artifacts/fased-hosted-app-v2-linux-arm64-v${version}.tar.gz \
    "$release_assets/fased-hosted-app-v2-linux-arm64-v${version}.tar.gz"
  local dependency_asset=""
  dependency_asset="$(basename "$(find /artifacts -maxdepth 1 -type f \
    -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit)")"
  install -m 0644 "/artifacts/$dependency_asset" "$release_assets/$dependency_asset"
  install -m 0644 \
    "/artifacts/${dependency_asset/linux-x64/linux-arm64}" \
    "$release_assets/${dependency_asset/linux-x64/linux-arm64}"
  local signer_asset=""
  for signer_asset in \
    fased-signerd-linux-amd64 \
    fased-signerd-linux-arm64 \
    fased-signerd-darwin-amd64 \
    fased-signerd-darwin-arm64 \
    fased-signerd-release.json; do
    install -m 0644 "/artifacts/$signer_asset" "$release_assets/$signer_asset"
  done
  install -m 0644 /artifacts/fased-hosted-components-linux-x64-v${version}.spdx.json \
    "$release_assets/fased-hosted-components-linux-x64-v${version}.spdx.json"
  install -m 0644 /artifacts/fased-hosted-components-linux-x64-v${version}.spdx.json \
    "$release_assets/fased-hosted-components-linux-arm64-v${version}.spdx.json"
  install -m 0644 /artifacts/fased-signerd-components-v${version}.spdx.json \
    "$release_assets/fased-signerd-components-v${version}.spdx.json"

  local issued_at=""
  local expires_at=""
  issued_at="$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%S.000Z)"
  expires_at="$(date -u -d '364 days' +%Y-%m-%dT%H:%M:%S.000Z)"
  /usr/local/bin/node /repo/scripts/privileged-release-evidence.mjs build \
    --assets "$release_assets" \
    --version "$version" \
    --commit "$commit" \
    --issued-at "$issued_at" \
    --vex-decisions /repo/release/vulnerability-decisions-v1.json \
    --output-dir "$release_assets"
  /usr/local/bin/node /repo/scripts/build-lifecycle-trust-metadata.mjs \
    --assets "$release_assets" \
    --root-policy /repo/release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json \
    --version "$version" \
    --commit "$commit" \
    --issued-at "$issued_at" \
    --expires-at "$expires_at" \
    --output "$release_assets/fased-lifecycle-trust-v1.json"
  local bundle=""
  for bundle in \
    fased-hosted-release-v2.json.attestation.json \
    fased-lifecycle-supervisor.mjs.attestation.json \
    fased-host-updater.mjs.attestation.json \
    fased-host-updaterctl.mjs.attestation.json \
    fased-lifecycle-trust-v1.json.attestation.json \
    fased-privileged-provenance-v1.intoto.json.attestation.json \
    fased-signerd-release.attestation.json; do
    printf '{"fixtureOfflineAttestation":true}\n' >"$release_assets/$bundle"
    chmod 0644 "$release_assets/$bundle"
  done

  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
    -subj "/CN=Fased Hosting lifecycle fixture CA" \
    -keyout "$fixture_tls/ca.key" \
    -out "$fixture_tls/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -subj "/CN=github.com" \
    -keyout "$fixture_tls/github.key" \
    -out "$fixture_tls/github.csr" >/dev/null 2>&1
  cat >"$fixture_tls/github.ext" <<'EOF_FIXTURE_TLS_EXT'
subjectAltName=DNS:github.com
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF_FIXTURE_TLS_EXT
  openssl x509 -req -sha256 -days 2 \
    -in "$fixture_tls/github.csr" \
    -CA "$fixture_tls/ca.crt" \
    -CAkey "$fixture_tls/ca.key" \
    -CAcreateserial \
    -extfile "$fixture_tls/github.ext" \
    -out "$fixture_tls/github.crt" >/dev/null 2>&1
  chmod 0600 "$fixture_tls/ca.key" "$fixture_tls/github.key"
  chmod 0644 "$fixture_tls/ca.crt" "$fixture_tls/github.crt"
  install -m 0644 "$fixture_tls/ca.crt" \
    /usr/local/share/ca-certificates/fased-hosting-lifecycle-fixture.crt
  update-ca-certificates >/dev/null
  grep -Fqx "127.0.0.1 github.com" /etc/hosts ||
    printf '127.0.0.1 github.com\n' >>/etc/hosts
  install -d -m 0755 /etc/systemd/system.conf.d
  cat >/etc/systemd/system.conf.d/90-fased-fixture-ca.conf <<EOF_FIXTURE_SYSTEMD_CA
[Manager]
DefaultEnvironment=NODE_EXTRA_CA_CERTS=$fixture_tls/ca.crt
EOF_FIXTURE_SYSTEMD_CA

  cat >/usr/local/libexec/fased-fixture-github.mjs <<'EOF_FIXTURE_GITHUB'
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const version = process.env.FASED_FIXTURE_VERSION;
const releaseAssets = "/var/lib/fased-hosting-fixture/release-assets";
const releasePrefix = `/fased-ai/fased/releases/download/v${version}/`;
https
  .createServer(
    {
      key: fs.readFileSync("/var/lib/fased-hosting-fixture/tls/github.key"),
      cert: fs.readFileSync("/var/lib/fased-hosting-fixture/tls/github.crt"),
    },
    (request, response) => {
      if (request.method !== "GET" || !request.url?.startsWith(releasePrefix)) {
        response.writeHead(404).end();
        return;
      }
      const asset = decodeURIComponent(request.url.slice(releasePrefix.length));
      if (!/^[A-Za-z0-9._-]+$/.test(asset)) {
        response.writeHead(400).end();
        return;
      }
      const selected = path.join(releaseAssets, asset);
      try {
        const info = fs.statSync(selected);
        if (!info.isFile()) throw new Error("not a file");
        response.writeHead(200, { "content-length": info.size });
        fs.createReadStream(selected).pipe(response);
      } catch {
        response.writeHead(404).end();
      }
    },
  )
  .listen(443, "127.0.0.1");
EOF_FIXTURE_GITHUB
  cat >/etc/systemd/system/fased-fixture-github.service <<EOF_FIXTURE_GITHUB_UNIT
[Unit]
Description=Fased fixture exact GitHub release transport
After=network.target

[Service]
Type=simple
Environment=FASED_FIXTURE_VERSION=$version
ExecStart=/usr/local/bin/node /usr/local/libexec/fased-fixture-github.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF_FIXTURE_GITHUB_UNIT
  systemctl daemon-reexec
  systemctl enable --now fased-fixture-github.service
  wait_for_service fased-fixture-github.service
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

if [[ "$phase" == "controller-status" ]]; then
  diagnostic_transaction_id="$(/usr/local/bin/node -e 'process.stdout.write(crypto.randomUUID())')"
  lifecycle_socket_requests \
    /run/fased-host-controller/controller.sock \
    controllerStatus \
    "$diagnostic_transaction_id" \
    "$version" \
    1 \
    /tmp/hosting-controller-diagnostic-status.json
  cat /tmp/hosting-controller-diagnostic-status.json
  exit 0
fi

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
  run_app_cli update --channel beta >/tmp/hosting-already-current.out
  grep -Fx "Already current: $version" /tmp/hosting-already-current.out >/dev/null
  printf 'Hosting reboot fixture passed: %s\n' "$version"
  exit 0
fi

[[ "$phase" == "install" ]] || {
  echo "usage: fased-hosting-systemd-fixture install|verify-reboot" >&2
  exit 64
}

install_fixture_command_shims
prepare_candidate_release_transport
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

verify_supervised_controller_a_to_b

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
