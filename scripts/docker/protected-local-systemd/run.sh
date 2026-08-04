#!/usr/bin/env bash
set -euo pipefail
trap 'status=$?; printf "fixture command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2; exit "$status"' ERR

phase="${1:-install}"
fixture_started="$SECONDS"
version="${FASED_FIXTURE_VERSION:?missing fixture version}"
commit="${FASED_FIXTURE_COMMIT:?missing fixture commit}"
legacy_version="${FASED_FIXTURE_LEGACY_VERSION:-0.1.75}"
preinstalled_tools="${FASED_FIXTURE_PREINSTALLED_TOOLS:-0}"
target_update_args=()
if [[ "$version" == *-* ]]; then
  target_update_args=(--channel beta)
fi
digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
release_root="/var/lib/fased-installer/releases/v${version}/${digest}/extract/package"
root_store="$(dirname "$(dirname "$release_root")")"
candidate_repo=/var/lib/fased-protected-local-candidate
candidate_installer=/var/lib/fased-protected-local-install.sh
legacy_repo=/var/lib/fased-protected-local-predecessor
legacy_installer=/var/lib/fased-protected-local-predecessor-install.sh
state=/home/testop/.fased
runtime="$state/runtime/releases/$version"
legacy_runtime="$state/runtime/releases/$legacy_version"
gateway_port=19456
rpc_port=19457
gateway_token=fased-protected-local-fixture-token
snapshot=/var/lib/fased-protected-local-fixture.json
selected_target=/var/lib/fased-protected-local-fixture/selected-target-version
release_assets=/var/lib/fased-protected-local-fixture/release-assets
fixture_tls=/var/lib/fased-protected-local-fixture/tls
fixture_acl_user=fased-fixture-acl
fixture_acl_uid=2001

prepare_restrictive_home_acl() {
  if ! id "$fixture_acl_user" >/dev/null 2>&1; then
    useradd --uid "$fixture_acl_uid" --user-group --no-create-home --shell /usr/sbin/nologin \
      "$fixture_acl_user"
  fi
  chown testop:testop /home/testop
  chmod 0700 /home/testop
  setfacl --modify \
    group::---,user:"$fixture_acl_uid":--x,mask::--x,other::--- \
    /home/testop
}

capture_home_acl() {
  getfacl --omit-header --absolute-names --numeric -- /home/testop
}

verify_original_home_acl() {
  test "$(capture_home_acl)" = "$original_home_acl"
  test "$(stat -c '%U:%G' /home/testop)" = "testop:testop"
}

verify_protected_home_acl() {
  local instance="$1"
  local gateway_uid=""
  local acl=""
  gateway_uid="$(id -u "fsgw-$instance")"
  acl="$(capture_home_acl)"
  grep -Fx "user:$fixture_acl_uid:--x" <<<"$acl" >/dev/null
  grep -Fx "user:$gateway_uid:--x" <<<"$acl" >/dev/null
  grep -Fx "group::---" <<<"$acl" >/dev/null
  grep -Fx "mask::--x" <<<"$acl" >/dev/null
  grep -Fx "other::---" <<<"$acl" >/dev/null
  test "$(stat -c '%U:%G' /home/testop)" = "testop:testop"
}

operator_env() {
  local instance="$1"
  printf '%s\n' \
    "HOME=/home/testop" \
    "FASED_STATE_DIR=$state" \
    "FASED_CONFIG_PATH=$state/fased.json" \
    "FASED_GATEWAY_PORT=$gateway_port" \
    "FASED_GATEWAY_TOKEN=$gateway_token" \
    "FASED_HOST_PROFILE=local" \
    "FASED_PROTECTED_LOCAL=1" \
    "FASED_PROTECTED_LOCAL_INSTANCE=$instance" \
    "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external" \
    "FASED_WALLET_LOCAL_SIGNER_BIN=/opt/fased/local/$instance/signer/fased-signerd" \
    "FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-local/$instance/application/app.sock" \
    "FASED_HOST_UPDATER_SOCKET=/run/fased-local-controller/$instance/request.sock" \
    "FASED_HOST_UPDATERCTL_STATE=$state/protected-local-controller-transaction.json"
}

resolve_protected_runtime() {
  local instance="$1"
  local resolved=""
  resolved="$(readlink -f "$state/runtime/current")"
  case "$resolved" in
    "/opt/fased/local/$instance/application/releases/"*) printf '%s\n' "$resolved" ;;
    *)
      echo "Protected Local runtime selector escaped the root-controlled application store" >&2
      return 1
      ;;
  esac
}

verify_shared_device_auth() {
  local instance="$1"
  local runtime_root="$2"
  local module_url="file://$runtime_root/dist/infra/device-auth-store.js"
  local auth_file="$state/identity/device-auth.json"
  local -a environment=()
  mapfile -t environment < <(operator_env "$instance")
  runuser -u testop -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const store = await import(process.env.FASED_FIXTURE_MODULE_URL);
      store.storeDeviceAuthToken({
        deviceId: "fixture-shared-device",
        role: "operator",
        token: "fixture-operator-token",
      });
    '
  test "$(stat -c '%U:%G:%a' "$auth_file")" = "testop:fscf-$instance:660"
  runuser -u "fsgw-$instance" -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
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
  test "$(stat -c '%U:%G:%a' "$auth_file")" = "testop:fscf-$instance:660"
}

verify_mining_history() {
  runuser -u testop -- env \
    HOME=/home/testop \
    USER=testop \
    LOGNAME=testop \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    FASED_NODE=/usr/local/bin/node \
    "$state/bin/fased" mining history \
    --url "ws://127.0.0.1:$gateway_port" \
    --token "$gateway_token" \
    --timeout 5000 \
    --json \
    >/tmp/mining-history.json
  jq -e 'type == "object"' /tmp/mining-history.json >/dev/null
}

run_as_stale_operator() {
  /usr/bin/setpriv \
    --reuid "$(id -u testop)" \
    --regid "$(id -g testop)" \
    --clear-groups \
    -- \
    env \
      HOME=/home/testop \
      USER=testop \
      LOGNAME=testop \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      FASED_NODE=/usr/local/bin/node \
      npm_config_registry="http://127.0.0.1:$rpc_port" \
      "$@"
}

verify_profileless_config_write() {
  local instance="$1"
  local runtime_root="$2"
  runuser -u testop -- env -i \
    HOME=/home/testop \
    USER=testop \
    LOGNAME=testop \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    FASED_NODE=/usr/local/bin/node \
    /usr/local/bin/node "$runtime_root/fased.mjs" config set gateway.mode local \
    >/tmp/profileless-config-write.out
  test "$(stat -c '%U:%G:%a' "$state/fased.json")" = \
    "testop:fscf-$instance:660"
  systemctl restart "fased-gateway-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$version"
}

verify_shared_federation_state() {
  local instance="$1"
  local runtime_root="$2"
  local module_url="file://$runtime_root/dist/federation/access-token.js"
  local token_file="$state/federation/access-token.json"
  local -a environment=()
  mapfile -t environment < <(operator_env "$instance")
  runuser -u testop -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
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
  test "$(stat -c '%U:%G:%a' "$state/federation")" = "testop:fscf-$instance:2770"
  test "$(stat -c '%U:%G:%a' "$token_file")" = "testop:fscf-$instance:660"
  runuser -u "fsgw-$instance" -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const federation = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const existing = await federation.loadPersistedFederationToken();
      if (existing?.tokenId !== "fixture-federation-token") process.exit(93);
      await federation.persistFederationAccessToken({ ...existing, hostedState: "ready" });
    '
  test "$(stat -c '%U:%G:%a' "$token_file")" = "fsgw-$instance:fscf-$instance:660"
  runuser -u testop -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const federation = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const existing = await federation.loadPersistedFederationToken();
      if (existing?.hostedState !== "ready") process.exit(94);
    '
}

verify_shared_wallet_registry() {
  local instance="$1"
  local runtime_root="$2"
  local module_url="file://$runtime_root/dist/wallet/wallet-provider-registry.js"
  local registry="$state/wallet/provider-registry.v1.json"
  local -a environment=()
  mapfile -t environment < <(operator_env "$instance")
  test "$(stat -c '%U:%G:%a' "$state/wallet")" = "testop:fscf-$instance:2770"
  test "$(stat -c '%U:%G:%a' "$registry")" = "testop:fscf-$instance:660"
  runuser -u "fsgw-$instance" -- env "${environment[@]}" FASED_FIXTURE_MODULE_URL="$module_url" \
    /usr/local/bin/node --input-type=module --eval '
      const registry = await import(process.env.FASED_FIXTURE_MODULE_URL);
      const wallets = registry.readWalletProviderRegistry().wallets;
      if (!wallets.some((wallet) => wallet.id === "agent")) process.exit(92);
    '
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

wait_for_service() {
  local unit="$1"
  for _ in {1..300}; do
    systemctl is-active --quiet "$unit" && return 0
    sleep 0.1
  done
  journalctl -u "$unit" -n 80 --no-pager >&2 || true
  return 1
}

wait_for_rpc() {
  local endpoint="$1"
  local expected_genesis="$2"
  local response=""
  for _ in {1..200}; do
    if response="$(
      curl -fsS --max-time 1 \
        -H "content-type: application/json" \
        --data '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' \
        "$endpoint" 2>/dev/null
    )" &&
      jq -e --arg expected "$expected_genesis" '.result == $expected' \
        <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  journalctl -u fased-fixture-solana-rpc.service -n 80 --no-pager >&2 || true
  echo "fixture Solana RPC did not become ready: $endpoint" >&2
  return 1
}

user_systemctl() {
  runuser -u testop -- env \
    XDG_RUNTIME_DIR=/run/user/2000 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2000/bus \
    systemctl --user "$@"
}

wait_for_user_manager() {
  local state=""
  for _ in {1..200}; do
    if [[ -S /run/user/2000/bus ]]; then
      state="$(user_systemctl is-system-running 2>/dev/null || true)"
      [[ "$state" == "running" || "$state" == "degraded" ]] && return 0
    fi
    sleep 0.1
  done
  echo "fixture user systemd manager did not become ready" >&2
  systemctl status user@2000.service --no-pager >&2 || true
  journalctl -u user@2000.service -n 80 --no-pager >&2 || true
  ls -la /run/user/2000 /run/user/2000/bus >&2 2>/dev/null || true
  return 1
}

wait_for_gateway_version() {
  local expected="$1"
  local response=""
  for _ in {1..300}; do
    if response="$(curl -fsS --max-time 1 "http://127.0.0.1:$gateway_port/healthz" 2>/dev/null)" &&
      jq -e --arg expected "$expected" \
        '.version == $expected and (.runtimeSource == "managed-package" or .runtimeSource == "packaged-runtime")' \
        <<<"$response" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "Gateway did not report expected version: $expected" >&2
  return 1
}

bootstrap() {
  local mode="$1"
  /usr/local/bin/node /repo/scripts/protected-local-bootstrap.mjs install \
    --source-root "$release_root" \
    --signer-binary "$root_store/verified-assets/fased-signerd" \
    --operator-user testop \
    --operator-uid 2000 \
    --operator-gid 2000 \
    --operator-home /home/testop \
    --state-dir "$state" \
    --runtime-dir "$runtime" \
    --node-binary /usr/local/bin/node \
    --release-version "$version" \
    --release-commit "$commit" \
    --update-channel "$([[ "$version" == *-* ]] && printf beta || printf stable)" \
    --profile default \
    --gateway-port "$gateway_port" \
    --gateway-mode "$mode" \
    --gateway-health-timeout-ms 5000
}

verify_wallet() {
  local instance="$1"
  local wallet_id="$2"
  runuser -u testop -- "/opt/fased/local/$instance/signer/fased-signerd" \
    admin wallet readiness \
    --operator-socket "/run/fased-local/$instance/operator/operator.sock" \
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
  local instance="$1"
  local controller_state="/var/lib/fased-local/$instance/controller"
  local controller_root="/opt/fased/local/$instance/controller"
  local controller_unit="fased-local-controller-worker-$instance.service"
  local supervisor_unit="fased-local-controller-$instance.service"
  local public_socket="/run/fased-local-controller/$instance/request.sock"
  local private_socket="/run/fased-local-controller-worker/$instance/controller.sock"
  local target_generation=""
  local predecessor_generation="$controller_root/releases/v$legacy_version"
  local supervisor_identity="$controller_state/supervisor/controller-version.json"
  local product_identity="$controller_state/controller-version.json"
  local preservation_manifest=/tmp/controller-a-to-b-preservation.sha256
  local transaction_id=""
  local status_transaction_id=""
  local selection_digest=""
  local selection_receipt=""
  local target_manifest_sha=""
  local target_server_sha=""
  local target_client_sha=""
  local controller_pid=""
  local controller_drop_in="/etc/systemd/system/$controller_unit.d"
  local supervisor_drop_in="/etc/systemd/system/$supervisor_unit.d"
  local failure_marker="$controller_state/fixture-controller-restart-failure"
  local failure_script=/usr/local/libexec/fased-fixture-controller-fail-once
  local failure_override="$controller_drop_in/99-fixture-fail-once.conf"

  printf 'generated-systemd controller transition stage: preflight\n'
  target_generation="$(readlink -f "$controller_root/current")"
  [[ "$target_generation" == "$controller_root/releases/v$version" ]] || {
    echo "generated-systemd preflight: active controller generation is not the target" >&2
    return 1
  }
  [[ -f "$supervisor_identity" ]] || {
    echo "generated-systemd preflight: supervisor controller identity is missing" >&2
    return 1
  }
  [[ -d "$controller_drop_in" ]] || {
    echo "generated-systemd preflight: target controller drop-in boundary is missing" >&2
    return 1
  }
  [[ -d "$supervisor_drop_in" ]] || {
    echo "generated-systemd preflight: supervisor drop-in boundary is missing" >&2
    return 1
  }
  if find "$controller_drop_in" "$supervisor_drop_in" \
    -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "generated-systemd preflight: protected unit drop-in boundary is not empty" >&2
    find "$controller_drop_in" "$supervisor_drop_in" \
      -mindepth 1 -maxdepth 1 -printf '%m %u:%g %p\n' >&2
    return 1
  fi

  printf 'generated-systemd controller transition stage: preservation-state\n'
  install -d -m 2770 -o testop -g "fscf-$instance" \
    "$state/sat-mining/wallets/agent" "$state/extensions"
  runuser -u testop -- env FASED_FIXTURE_MINING_LEDGER="$state/sat-mining/wallets/agent/mining.sqlite" \
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
  chown testop:"fscf-$instance" "$state/sat-mining/wallets/agent/mining.sqlite"
  chmod 0660 "$state/sat-mining/wallets/agent/mining.sqlite"
  printf '{"schemaVersion":1,"rpc":"fixture-rpc","policy":"agent"}\n' \
    >"$state/wallet/fixture-policy-rpc.json"
  printf '{"schemaVersion":1,"enabled":["fixture"]}\n' \
    >"$state/extensions/fixture-plugin-state.json"
  chown testop:"fscf-$instance" \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"
  chmod 0660 \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"

  sha256sum \
    "$state/wallet/provider-registry.v1.json" \
    "$state/wallet/fixture-policy-rpc.json" \
    "$controller_state/../signer/state.db" \
    "$controller_state/../signer/master.key" \
    "$state/sat-mining/wallets/agent/mining.sqlite" \
    "$state/federation/access-token.json" \
    "$state/extensions/fixture-plugin-state.json" \
    >"$preservation_manifest"

  printf 'generated-systemd controller transition stage: predecessor-activation\n'
  systemctl stop "$supervisor_unit" "$controller_unit"
  rm -rf -- "$predecessor_generation"
  install -d -m 0755 -o root -g root "$predecessor_generation"
  install -m 0644 -o root -g root \
    "$target_generation/fased-host-updater.mjs" \
    "$predecessor_generation/fased-host-updater.mjs"
  install -m 0644 -o root -g root \
    "$target_generation/fased-host-updaterctl.mjs" \
    "$predecessor_generation/fased-host-updaterctl.mjs"
  jq --arg version "$legacy_version" '.version = $version' "$supervisor_identity" \
    >/tmp/controller-predecessor-identity.json
  install -m 0600 -o root -g root \
    /tmp/controller-predecessor-identity.json "$supervisor_identity"
  install -m 0600 -o root -g root \
    /tmp/controller-predecessor-identity.json "$product_identity"
  ln -s "$predecessor_generation" "$controller_root/current.fixture"
  mv -Tf "$controller_root/current.fixture" "$controller_root/current"
  systemctl start "$controller_unit" "$supervisor_unit"
  wait_for_service "$controller_unit"
  wait_for_service "$supervisor_unit"
  wait_for_socket "$private_socket"
  wait_for_socket "$public_socket"

  status_transaction_id="$(/usr/local/bin/node -e 'process.stdout.write(crypto.randomUUID())')"
  lifecycle_socket_requests \
    "$private_socket" controllerStatus "$status_transaction_id" "$legacy_version" 1 \
    /tmp/controller-predecessor-status.json
  jq -e --arg version "$legacy_version" \
    'length == 1 and .[0].ok == true and .[0].controllerVersion == $version' \
    /tmp/controller-predecessor-status.json >/dev/null

  printf 'generated-systemd controller transition stage: injected-rollback\n'
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
    /tmp/controller-transition-failure.json
  jq -e \
    'length == 1 and .[0].ok == false and (.[0].error | contains("controller promotion failed and was restored"))' \
    /tmp/controller-transition-failure.json >/dev/null
  wait_for_service "$controller_unit"
  test "$(readlink -f "$controller_root/current")" = "$predecessor_generation"
  test "$(jq -r .version "$supervisor_identity")" = "$legacy_version"
  test ! -e "$controller_state/supervisor/controller-transaction.json"
  test ! -e "$failure_marker"
  sha256sum --check --status "$preservation_manifest"

  printf 'generated-systemd controller transition stage: same-command-retry\n'
  rm -f -- "$failure_override" "$failure_script"
  systemctl daemon-reload
  systemctl reset-failed "$controller_unit"
  lifecycle_socket_requests \
    "$public_socket" updateController "$transaction_id" "$version" 2 \
    /tmp/controller-transition-success.json
  jq -e --arg version "$version" \
    'length == 2 and .[0].ok == true and .[0].version == $version and .[0].controllerChanged == true and .[1].ok == true and .[1].version == $version and .[1].controllerChanged == false and (.[1].controllerInstanceId | type == "string") and (.[1].selectionDigest | test("^[a-f0-9]{64}$"))' \
    /tmp/controller-transition-success.json >/dev/null
  wait_for_service "$controller_unit"
  wait_for_service "$supervisor_unit"
  test "$(readlink -f "$controller_root/current")" = "$target_generation"
  test "$(jq -r .version "$supervisor_identity")" = "$version"
  # Retain the last ordinary controller generation as the exact rollback
  # source. Only explicitly named historical Q0 candidates are disposable.
  test -d "$predecessor_generation"
  test ! -L "$predecessor_generation"
  test "$(stat -c '%u:%g:%a' "$predecessor_generation")" = "0:0:755"
  test "$(sha256sum "$predecessor_generation/fased-host-updater.mjs" | awk '{print $1}')" = \
    "$(sha256sum "$target_generation/fased-host-updater.mjs" | awk '{print $1}')"
  test "$(sha256sum "$predecessor_generation/fased-host-updaterctl.mjs" | awk '{print $1}')" = \
    "$(sha256sum "$target_generation/fased-host-updaterctl.mjs" | awk '{print $1}')"
  test ! -e "$controller_state/supervisor/controller-transaction.json"
  sha256sum --check --status "$preservation_manifest"

  printf 'generated-systemd controller transition stage: receipt-binding\n'
  selection_digest="$(jq -er '.[1].selectionDigest' /tmp/controller-transition-success.json)"
  selection_receipt="$controller_state/supervisor/controller-selections/$transaction_id/$selection_digest.json"
  target_manifest_sha="$(sha256sum "$release_assets/fased-hosted-release-v2.json" | awk '{print $1}')"
  target_server_sha="$(sha256sum "$target_generation/fased-host-updater.mjs" | awk '{print $1}')"
  target_client_sha="$(sha256sum "$target_generation/fased-host-updaterctl.mjs" | awk '{print $1}')"
  jq -e \
    --arg transaction "$transaction_id" \
    --arg version "$version" \
    --arg commit "$commit" \
    --arg manifest "$target_manifest_sha" \
    --arg server "$target_server_sha" \
    --arg client "$target_client_sha" \
    --arg instance "$(jq -er '.[1].controllerInstanceId' /tmp/controller-transition-success.json)" \
    --arg selection "$selection_digest" \
    '.transactionId == $transaction and .version == $version and .releaseCommit == $commit and .targetManifestSha256 == $manifest and .controllerServerSha256 == $server and .controllerClientSha256 == $client and .controllerInstanceId == $instance and .selectionDigest == $selection and .protocolCapabilities == {"controllerProtocol":2,"requestSchema":2,"supervisorProtocol":1}' \
    "$selection_receipt" >/dev/null
  test "$(cat "$controller_state/supervisor/controller-selections/$transaction_id/current")" = \
    "$selection_digest"

  printf 'generated-systemd controller transition stage: namespace-denial\n'
  controller_pid="$(systemctl show -p MainPID --value "$controller_unit")"
  test "$controller_pid" -gt 1
  if nsenter --target "$controller_pid" --mount -- \
    mkdir "$controller_root/fixture-forbidden-controller-write" 2>/tmp/controller-write.err; then
    echo "target controller wrote its supervisor-owned generation tree" >&2
    exit 1
  fi
  if nsenter --target "$controller_pid" --mount -- \
    touch "$controller_drop_in/fixture-forbidden.conf" 2>/tmp/controller-drop-in-write.err; then
    echo "target controller wrote its own systemd drop-in" >&2
    exit 1
  fi
  if nsenter --target "$controller_pid" --mount -- \
    touch "$supervisor_drop_in/fixture-forbidden.conf" 2>/tmp/supervisor-drop-in-write.err; then
    echo "target controller wrote the supervisor systemd drop-in" >&2
    exit 1
  fi
  test ! -e "$controller_root/fixture-forbidden-controller-write"
  test ! -e "$controller_drop_in/fixture-forbidden.conf"
  test ! -e "$supervisor_drop_in/fixture-forbidden.conf"
  printf 'generated-systemd supervised controller A-to-B rollback/retry fixture passed: %s\n' \
    "$instance"
}

if [[ "$phase" == "verify-reboot" ]]; then
  [[ -f "$snapshot" ]]
  instance="$(jq -er .instanceId "$snapshot")"
  runtime="$(resolve_protected_runtime "$instance")"
  wait_for_user_manager
  wait_for_service "fased-local-controller-$instance.service"
  wait_for_service "fased-signerd-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$version"
  wait_for_socket "/run/fased-local/$instance/operator/operator.sock"
  verify_protected_home_acl "$instance"
  mapfile -t env_args < <(operator_env "$instance")
  verify_shared_device_auth "$instance" "$runtime"
  verify_mining_history
  verify_shared_federation_state "$instance" "$runtime"
  runuser -u testop -- env "${env_args[@]}" \
    /usr/local/bin/node "$runtime/fased.mjs" health --json --timeout 5000 \
    >/tmp/reboot-health.json
  jq -e '.ok == true' /tmp/reboot-health.json >/dev/null
  verify_wallet "$instance" agent >/tmp/reboot-agent.json
  verify_wallet "$instance" vault >/tmp/reboot-vault.json
  jq -e '.ready == true and .role == "agent"' /tmp/reboot-agent.json >/dev/null
  jq -e '.ready == true and .role == "vault"' /tmp/reboot-vault.json >/dev/null
  test "$(jq -S -c . /tmp/reboot-agent.json | sha256sum | awk '{print $1}')" = \
    "$(jq -r .agentReadinessSha256 "$snapshot")"
  test "$(jq -S -c . /tmp/reboot-vault.json | sha256sum | awk '{print $1}')" = \
    "$(jq -r .vaultReadinessSha256 "$snapshot")"
  test "$(sha256sum "/var/lib/fased-local/$instance/signer/master.key" | awk '{print $1}')" = \
    "$(jq -r .masterKeySha256 "$snapshot")"
  ss -ltn | grep -Eq "127\\.0\\.0\\.1:${gateway_port}[[:space:]]"
  if ss -ltn | grep -Eq "(0\\.0\\.0\\.0|\\[::\\]):${gateway_port}[[:space:]]"; then
    echo "Protected Local Gateway became publicly bound after reboot." >&2
    exit 1
  fi
  if user_systemctl is-active --quiet fased-gateway.service; then
    echo "legacy user Gateway restarted after protected Local reboot" >&2
    exit 1
  fi
  printf 'protected Local reboot fixture passed: %s\n' "$instance"
  exit 0
fi

[[ "$phase" == "install" || "$phase" == "fresh-install" ]] || {
  echo "usage: fased-protected-local-systemd-fixture fresh-install|install|verify-reboot" >&2
  exit 64
}

useradd --uid 2000 --user-group --create-home --shell /bin/bash testop
prepare_restrictive_home_acl
original_home_acl="$(capture_home_acl)"
loginctl enable-linger testop
systemctl start user@2000.service
wait_for_user_manager
install -d -m 0755 -o root -g root "$release_root/scripts" "$release_root/dist"
install -d -m 0755 -o root -g root \
  "$root_store/verified-assets" \
  "$root_store/verified-dependencies"

runtime_asset="/artifacts/fased-hosted-linux-x64-v${version}.tar.gz"
[[ -f "$runtime_asset" ]]
artifact_extract="/var/lib/fased-protected-local-artifact/package"
install -d -m 0755 -o root -g root "$artifact_extract"
tar -xzf "$runtime_asset" -C "$artifact_extract" --strip-components=1
cp -a "$artifact_extract/." "$release_root/"
cp -a "$artifact_extract/node_modules" "$root_store/verified-dependencies/node_modules"
rm -rf "$release_root/node_modules"

for script in fased-host-updater.mjs fased-host-updaterctl.mjs fased-signer-owner-hosting.sh; do
  cmp "/repo/scripts/$script" "$release_root/scripts/$script"
done
install -m 0755 -o root -g root /artifacts/fased-signerd-linux-amd64 \
  "$root_store/verified-assets/fased-signerd"

signer_sha="$(sha256sum "$root_store/verified-assets/fased-signerd" | awk '{print $1}')"
dependency_hash="$(jq -er '.dependencyHash' "$release_root/.fased-hosted-runtime.json")"
printf 'version=%s\ncommit=%s\nsigner_sha256=%s\ndependency_sha256=%s\ndependency_hash=%s\n' \
  "$version" "$commit" "$signer_sha" "$(printf fixture | sha256sum | awk '{print $1}')" "$dependency_hash" \
  >"$release_root/.fased-hosting-bundle-verified"
chmod 0600 "$release_root/.fased-hosting-bundle-verified"
test "$(jq -er .version "$release_root/package.json")" = "$version"

rm -rf "$candidate_repo"
git clone --quiet --no-hardlinks /repo "$candidate_repo"
git -C "$candidate_repo" checkout --quiet --detach "$commit"
git -C "$candidate_repo" tag --force "v$version" "$commit"
chown -R testop:testop "$candidate_repo"
install -m 0700 -o testop -g testop "$candidate_repo/install.sh" "$candidate_installer"
if [[ "$phase" == "install" ]]; then
  legacy_commit="$(jq -er .release.commit /legacy-artifacts/fased-hosted-release-v2.json)"
  rm -rf "$legacy_repo"
  git clone --quiet --no-hardlinks /repo "$legacy_repo"
  git -C "$legacy_repo" checkout --quiet --detach "$legacy_commit"
  test "$(git -C "$legacy_repo" rev-parse "v${legacy_version}^{commit}")" = "$legacy_commit"
  # The source checkout intentionally carries a placeholder identity, while
  # the immutable release asset is stamped with the published version. Compare
  # the scripts after normalizing only that one release-identity line.
  normalize_installer_identity() {
    sed -E 's/^install_entry_release_identity="[^"]*"$/install_entry_release_identity="__FASED_RELEASE_IDENTITY__"/' "$1"
  }
  cmp <(normalize_installer_identity "$legacy_repo/install.sh") \
    <(normalize_installer_identity /legacy-artifacts/install.sh)
  chown -R testop:testop "$legacy_repo"
  install -m 0700 -o testop -g testop \
    /legacy-artifacts/install.sh "$legacy_installer"
fi

install -d -m 0700 -o root -g root /opt/fased-fixture-bootstrap-tools
install -m 0755 -o root -g root "$(command -v jq)" \
  /opt/fased-fixture-bootstrap-tools/jq
cat >/opt/fased-fixture-bootstrap-tools/gh <<'EOF_FIXTURE_GH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "attestation" && "${2:-}" == "verify" ]]; then
  exit 0
fi
exit 1
EOF_FIXTURE_GH
chmod 0755 /opt/fased-fixture-bootstrap-tools/gh

install -d -m 0755 -o root -g root /var/lib/fased-protected-local-fixture
app_asset="fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
dependency_asset="$(basename "$(find /artifacts -maxdepth 1 -type f \
  -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit)")"
app_sha="$(sha256sum "/artifacts/$app_asset" | awk '{print $1}')"
dependency_sha="$(sha256sum "/artifacts/$dependency_asset" | awk '{print $1}')"
signer_build_input_digest="$(jq -er .buildInputDigest /artifacts/fased-signerd-release.json)"
env \
  FASED_FIXTURE_APP_ASSET="$app_asset" \
  FASED_FIXTURE_APP_SHA="$app_sha" \
  FASED_FIXTURE_COMMIT="$commit" \
  FASED_FIXTURE_DEPENDENCY_ASSET="$dependency_asset" \
  FASED_FIXTURE_DEPENDENCY_HASH="$dependency_hash" \
  FASED_FIXTURE_DEPENDENCY_SHA="$dependency_sha" \
  FASED_FIXTURE_SIGNER_BUILD_INPUT_DIGEST="$signer_build_input_digest" \
  FASED_FIXTURE_SIGNER_SHA="$signer_sha" \
  FASED_FIXTURE_VERSION="$version" \
  /usr/local/bin/node --input-type=module <<'EOF_LOCAL_MANIFEST'
import fs from "node:fs";
import {
  digestJSON,
  HOSTED_SIGNER_CAPABILITIES_V2,
} from "/repo/scripts/build-hosted-release-manifest.mjs";

const env = process.env;
const artifact = {
  asset: env.FASED_FIXTURE_APP_ASSET,
  sha256: env.FASED_FIXTURE_APP_SHA,
};
const dependencies = {
  asset: env.FASED_FIXTURE_DEPENDENCY_ASSET,
  sha256: env.FASED_FIXTURE_DEPENDENCY_SHA,
  dependencyHash: env.FASED_FIXTURE_DEPENDENCY_HASH,
};
const signerArtifact = {
  asset: "fased-signerd-linux-amd64",
  sha256: env.FASED_FIXTURE_SIGNER_SHA,
};
const manifest = {
  schemaVersion: 2,
  release: {
    version: env.FASED_FIXTURE_VERSION,
    tag: `v${env.FASED_FIXTURE_VERSION}`,
    commit: env.FASED_FIXTURE_COMMIT,
  },
  application: {
    linux: {
      x64: { artifact, dependencies },
      arm64: {
        artifact: { ...artifact, asset: "unused-arm64-app.tar.gz" },
        dependencies: { ...dependencies, asset: "unused-arm64-dependencies.tar.gz" },
      },
    },
  },
  signer: {
    release: {
      version: env.FASED_FIXTURE_VERSION,
      commit: env.FASED_FIXTURE_COMMIT,
      buildInputDigest: env.FASED_FIXTURE_SIGNER_BUILD_INPUT_DIGEST,
      development: false,
    },
    capabilities: HOSTED_SIGNER_CAPABILITIES_V2,
    capabilitiesDigest: digestJSON(HOSTED_SIGNER_CAPABILITIES_V2),
    platforms: {
      "linux-amd64": signerArtifact,
      "linux-arm64": { ...signerArtifact, asset: "fased-signerd-linux-arm64" },
      "darwin-amd64": { ...signerArtifact, asset: "fased-signerd-darwin-amd64" },
      "darwin-arm64": { ...signerArtifact, asset: "fased-signerd-darwin-arm64" },
    },
  },
};
fs.writeFileSync(
  "/var/lib/fased-protected-local-fixture/local-release-manifest.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
EOF_LOCAL_MANIFEST
printf '{}\n' >/var/lib/fased-protected-local-fixture/local-release-manifest.json.attestation.json
chmod 0444 \
  /var/lib/fased-protected-local-fixture/local-release-manifest.json \
  /var/lib/fased-protected-local-fixture/local-release-manifest.json.attestation.json

# The product protocol accepts only the fixed official release origin. Keep
# candidate source substitution entirely inside this disposable fixture by
# serving an exact release layout at a fixture-owned TLS endpoint for
# github.com. Every root-layer digest, trust-policy, evidence, and attestation
# check still runs; only transport is substituted.
install -d -m 0755 -o root -g root "$release_assets" "$fixture_tls"
install -m 0644 \
  /var/lib/fased-protected-local-fixture/local-release-manifest.json \
  "$release_assets/fased-hosted-release-v2.json"
install -m 0644 -o root -g root \
  /var/lib/fased-protected-local-fixture/local-release-manifest.json \
  "$release_root/.fased-hosted-release-v2.json"
printf 'release_manifest_sha256=%s\n' \
  "$(sha256sum "$release_root/.fased-hosted-release-v2.json" | awk '{print $1}')" \
  >>"$release_root/.fased-hosting-bundle-verified"
install -m 0755 "$candidate_installer" "$release_assets/install.sh"
install -m 0755 /repo/scripts/fased-lifecycle-supervisor.mjs \
  "$release_assets/fased-lifecycle-supervisor.mjs"
install -m 0755 /repo/scripts/fased-host-updater.mjs \
  "$release_assets/fased-host-updater.mjs"
install -m 0755 /repo/scripts/fased-host-updaterctl.mjs \
  "$release_assets/fased-host-updaterctl.mjs"
install -m 0755 /repo/scripts/privileged-release-evidence.mjs \
  "$release_assets/fased-privileged-release-evidence.mjs"
install -m 0644 "/artifacts/$app_asset" "$release_assets/$app_asset"
install -m 0644 "/artifacts/$dependency_asset" "$release_assets/$dependency_asset"
install -m 0644 /artifacts/fased-signerd-linux-amd64 \
  "$release_assets/fased-signerd-linux-amd64"

# H0 exercises one x64 host. Complete the cross-platform evidence inventory
# with byte-identical fixture copies so the real evidence verifier can validate
# the canonical release schema without pretending to execute other platforms.
install -m 0644 "/artifacts/$app_asset" \
  "$release_assets/unused-arm64-app.tar.gz"
install -m 0644 "/artifacts/$dependency_asset" \
  "$release_assets/unused-arm64-dependencies.tar.gz"
for signer_asset in \
  fased-signerd-linux-arm64 \
  fased-signerd-darwin-amd64 \
  fased-signerd-darwin-arm64; do
  install -m 0644 /artifacts/fased-signerd-linux-amd64 \
    "$release_assets/$signer_asset"
done
install -m 0644 \
  "/artifacts/fased-hosted-components-linux-x64-v${version}.spdx.json" \
  "$release_assets/fased-hosted-components-linux-x64-v${version}.spdx.json"
install -m 0644 \
  "/artifacts/fased-hosted-components-linux-x64-v${version}.spdx.json" \
  "$release_assets/fased-hosted-components-linux-arm64-v${version}.spdx.json"
install -m 0644 \
  "/artifacts/fased-signerd-components-v${version}.spdx.json" \
  "$release_assets/fased-signerd-components-v${version}.spdx.json"

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
  -subj "/CN=Fased lifecycle fixture CA" \
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
if command -v update-ca-certificates >/dev/null 2>&1; then
  install -m 0644 "$fixture_tls/ca.crt" \
    /usr/local/share/ca-certificates/fased-lifecycle-fixture.crt
  update-ca-certificates >/dev/null
else
  install -m 0644 "$fixture_tls/ca.crt" \
    /etc/pki/ca-trust/source/anchors/fased-lifecycle-fixture.crt
  update-ca-trust extract
fi
grep -Fqx "127.0.0.1 github.com" /etc/hosts ||
  printf '127.0.0.1 github.com\n' >>/etc/hosts
install -d -m 0755 /etc/systemd/system.conf.d
cat >/etc/systemd/system.conf.d/90-fased-fixture-ca.conf <<EOF_FIXTURE_SYSTEMD_CA
[Manager]
DefaultEnvironment=NODE_EXTRA_CA_CERTS=$fixture_tls/ca.crt
EOF_FIXTURE_SYSTEMD_CA
systemctl daemon-reexec

cat >/usr/local/bin/curl <<'EOF_FIXTURE_CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
legacy_version="${FASED_FIXTURE_LEGACY_VERSION:-}"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    -o)
      output="${args[$((i + 1))]:-}"
      i=$((i + 1))
      ;;
    http://*|https://*) url="${args[$i]}" ;;
  esac
done
case "$url" in
  */v"$legacy_version"/fased-hosted-release-v2.json)
    install -m 0600 /legacy-artifacts/fased-hosted-release-v2.json "$output"
    ;;
  */v"$legacy_version"/fased-hosted-release-v2.json.attestation.json)
    install -m 0600 \
      /legacy-artifacts/fased-hosted-release-v2.json.attestation.json "$output"
    ;;
  */fased-hosted-release-v2.json)
    install -m 0600 /var/lib/fased-protected-local-fixture/local-release-manifest.json "$output"
    ;;
  */fased-hosted-release-v2.json.attestation.json)
    install -m 0600 \
      /var/lib/fased-protected-local-fixture/local-release-manifest.json.attestation.json "$output"
    ;;
  *) exec /usr/bin/curl "$@" ;;
esac
EOF_FIXTURE_CURL
chmod 0755 /usr/local/bin/curl
test "$(jq -er .version "$release_root/dist/build-info.json")" = "$version"
test "$(jq -er .commit "$release_root/dist/build-info.json")" = "$commit"
chown -R root:root "$release_root" "$root_store/verified-assets" "$root_store/verified-dependencies"
chmod -R a+rX,go-w "$release_root" "$root_store/verified-assets" "$root_store/verified-dependencies"
chmod 0600 "$release_root/.fased-hosting-bundle-verified"

install -d -m 0755 /usr/local/libexec
cat >/usr/local/libexec/fased-fixture-solana-rpc.mjs <<'EOF_RPC'
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
const port = Number(process.env.FASED_FIXTURE_RPC_PORT);
const version = process.env.FASED_FIXTURE_VERSION;
const legacyVersion = process.env.FASED_FIXTURE_LEGACY_VERSION;
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // pragma: allowlist secret
const releaseAssets = "/var/lib/fased-protected-local-fixture/release-assets";
const releasePrefix = `/fased-ai/fased/releases/download/v${version}/`;

function serveFile(response, selected) {
  try {
    const stat = fs.statSync(selected);
    if (!stat.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-length": stat.size });
    fs.createReadStream(selected).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}

function handleRequest(request, response) {
  if (request.method === "GET" && request.url?.startsWith("/@fased%2ffased")) {
    const selectedVersion = fs.readFileSync(
      "/var/lib/fased-protected-local-fixture/selected-target-version",
      "utf8",
    ).trim();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ "dist-tags": { latest: selectedVersion, beta: selectedVersion } }),
    );
    return;
  }
  if (request.method === "GET" && request.url?.startsWith(releasePrefix)) {
    const asset = decodeURIComponent(request.url.slice(releasePrefix.length));
    if (!/^[A-Za-z0-9._-]+$/.test(asset)) {
      response.writeHead(400).end();
      return;
    }
    serveFile(response, path.join(releaseAssets, asset));
    return;
  }
  if (request.method === "GET" && request.url?.startsWith(`/v${version}/`)) {
    const asset = decodeURIComponent(request.url.slice(`/v${version}/`.length));
    if (!/^[A-Za-z0-9._-]+$/.test(asset)) {
      response.writeHead(400).end();
      return;
    }
    const selected =
      asset === "install.sh"
        ? "/usr/local/libexec/fased-fixture-protected-installer.sh"
        : asset === "fased-hosted-release-v2.json"
          ? "/var/lib/fased-protected-local-fixture/local-release-manifest.json"
          : asset === "fased-hosted-release-v2.json.attestation.json"
            ? "/var/lib/fased-protected-local-fixture/local-release-manifest.json.attestation.json"
            : fs.existsSync(path.join(releaseAssets, asset))
              ? path.join(releaseAssets, asset)
              : path.join("/artifacts", asset);
    serveFile(response, selected);
    return;
  }
  if (
    request.method === "GET" &&
    legacyVersion &&
    request.url?.startsWith(`/v${legacyVersion}/`)
  ) {
    const asset = decodeURIComponent(request.url.slice(`/v${legacyVersion}/`.length));
    if (!/^[A-Za-z0-9._-]+$/.test(asset)) {
      response.writeHead(400).end();
      return;
    }
    const selected = path.join("/legacy-artifacts", asset);
    serveFile(response, selected);
    return;
  }
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch {}
    let result;
    if (input.method === "getGenesisHash") result = genesis;
    else if (input.method === "getBalance") result = { context: { slot: 1 }, value: 2_000_000_000 };
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
}

http.createServer(handleRequest).listen(port, "127.0.0.1");
https
  .createServer(
    {
      key: fs.readFileSync("/var/lib/fased-protected-local-fixture/tls/github.key"),
      cert: fs.readFileSync("/var/lib/fased-protected-local-fixture/tls/github.crt"),
    },
    handleRequest,
  )
  .listen(443, "127.0.0.1");
EOF_RPC
cat >/usr/local/libexec/fased-fixture-legacy-gateway.mjs <<'EOF_LEGACY_GATEWAY'
import http from "node:http";

const port = Number(process.env.FASED_FIXTURE_GATEWAY_PORT);
const version = process.env.FASED_FIXTURE_LEGACY_VERSION;
http
  .createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version, runtimeSource: "managed-package" }));
      return;
    }
    response.writeHead(404).end();
  })
  .listen(port, "127.0.0.1");
EOF_LEGACY_GATEWAY
cat >/usr/local/libexec/fased-fixture-protected-installer.sh <<EOF_PROTECTED_INSTALLER
#!/usr/bin/env bash
set -euo pipefail
umask 0117
declare -A values=()
while [[ "\$#" -gt 0 ]]; do
  case "\$1" in
    --protected-local-root-bootstrap) shift ;;
    --*) values["\$1"]="\${2:-}"; shift 2 ;;
    *) echo "unexpected fixture installer argument: \$1" >&2; exit 64 ;;
  esac
done
health_args=()
if [[ -n "\${values[--protected-local-gateway-health-timeout-ms]:-}" ]]; then
  health_args=(
    --gateway-health-timeout-ms
    "\${values[--protected-local-gateway-health-timeout-ms]}"
  )
fi
exec "\${values[--protected-local-node-binary]}" \
  /repo/scripts/protected-local-bootstrap.mjs install \
  --source-root "$release_root" \
  --signer-binary "$root_store/verified-assets/fased-signerd" \
  --operator-user "\${values[--protected-local-operator-user]}" \
  --operator-uid "\${values[--protected-local-operator-uid]}" \
  --operator-gid "\${values[--protected-local-operator-gid]}" \
  --operator-home "\${values[--protected-local-operator-home]}" \
  --state-dir "\${values[--protected-local-state-dir]}" \
  --runtime-dir "\${values[--protected-local-runtime-dir]}" \
  --node-binary "\${values[--protected-local-node-binary]}" \
  --release-version "\${values[--release]}" \
  --release-commit "$commit" \
  --update-channel "\${values[--update-channel]}" \
  --profile "\${values[--protected-local-profile]}" \
  --gateway-port "\${values[--protected-local-gateway-port]}" \
  --gateway-mode "\${values[--protected-local-gateway-mode]}" \
  "\${health_args[@]}"
EOF_PROTECTED_INSTALLER
chmod 0755 /usr/local/libexec/fased-fixture-protected-installer.sh
cat >/usr/local/bin/sudo <<'EOF_SUDO_SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" apt-get "* || " $* " == *" dnf "* || " $* " == *" dnf5 "* ]]; then
  printf 'fixture package-manager progress before verified commit\n'
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  /usr/bin/sudo /usr/bin/install -m 0755 \
    /opt/fased-fixture-bootstrap-tools/jq /usr/local/bin/jq
  /usr/bin/sudo /usr/bin/install -m 0755 \
    /opt/fased-fixture-bootstrap-tools/gh /usr/local/bin/gh
  exit 0
fi
if [[ "${1:-}" == "--" &&
  "${2:-}" == "/bin/bash" &&
  "${4:-}" == "--protected-local-root-bootstrap" ]]; then
  exec /usr/bin/sudo -- \
    /bin/bash /usr/local/libexec/fased-fixture-protected-installer.sh "${@:4}"
fi
exec /usr/bin/sudo "$@"
EOF_SUDO_SHIM
chmod 0755 /usr/local/bin/sudo
cat >/etc/systemd/system/fased-fixture-solana-rpc.service <<EOF_RPC_UNIT
[Unit]
Description=Fased fixture Solana RPC

[Service]
Type=simple
Environment=FASED_FIXTURE_RPC_PORT=$rpc_port
Environment=FASED_FIXTURE_VERSION=$version
Environment=FASED_FIXTURE_LEGACY_VERSION=$legacy_version
ExecStart=/usr/local/bin/node /usr/local/libexec/fased-fixture-solana-rpc.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF_RPC_UNIT
systemctl daemon-reload
systemctl enable --now fased-fixture-solana-rpc.service
wait_for_service fased-fixture-solana-rpc.service
wait_for_rpc \
  "http://127.0.0.1:$rpc_port" \
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" # pragma: allowlist secret

cat >/etc/sudoers.d/fased-protected-local-fixture <<'EOF_SUDOERS'
testop ALL=(root) NOPASSWD: ALL
EOF_SUDOERS
chmod 0440 /etc/sudoers.d/fased-protected-local-fixture
install -d -m 0755 -o root -g root /var/lib/fased-protected-local-fixture
printf '%s\n' "$version" >"$selected_target"
chmod 0644 "$selected_target"

if [[ "$phase" == "fresh-install" ]]; then
  fresh_prepare_elapsed="$((SECONDS - fixture_started))"
  if [[ "$preinstalled_tools" == "1" ]]; then
    install -m 0755 /opt/fased-fixture-bootstrap-tools/gh /usr/local/bin/gh
    install -m 0755 /opt/fased-fixture-bootstrap-tools/jq /usr/local/bin/jq
    command -v gh >/dev/null
    command -v jq >/dev/null
    gh attestation verify --help >/dev/null
  else
    rm -f /usr/local/bin/gh /usr/local/bin/jq /usr/bin/gh /usr/bin/jq
    if runuser -u testop -- env PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      /bin/bash -lc 'command -v gh || command -v jq'; then
      echo "fresh Local fixture did not start without gh and jq" >&2
      exit 1
    fi
  fi
  fresh_env=(
    HOME=/home/testop
    USER=testop
    LOGNAME=testop
    FASED_STATE_DIR="$state"
    FASED_CONFIG_PATH="$state/fased.json"
    FASED_GATEWAY_PORT="$gateway_port"
    FASED_GATEWAY_TOKEN="$gateway_token"
    FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port"
    FASED_INSTALL_REPO="$candidate_repo"
    npm_config_registry="http://127.0.0.1:$rpc_port"
  )
  fresh_channel="$([[ "$version" == *-* ]] && printf beta || printf stable)"
  install_started="$SECONDS"
  runuser -u testop -- env "${fresh_env[@]}" \
    /bin/bash "$candidate_installer" \
      --release "v$version" \
      --update-channel "$fresh_channel" \
      --local \
      --install-dir /home/testop/fased \
      -- \
      --non-interactive \
      --accept-risk \
      --auth-choice skip \
      --workspace /home/testop/.fased/workspace \
      --gateway-auth token \
      --gateway-token "$gateway_token" \
      --gateway-port "$gateway_port" \
      --gateway-bind loopback \
      --skip-skills \
      --skip-health \
    >/tmp/fresh-install.out 2>/tmp/fresh-install.err
  install_elapsed="$((SECONDS - install_started))"

  hash -r
  service_started="$SECONDS"
  test -s "$state/fased.json"
  test -s "$state/install.json"
  test "$(jq -r .profile "$state/install.json")" = "protected-local"
  instance="$(jq -er '.env.vars.FASED_PROTECTED_LOCAL_INSTANCE' "$state/fased.json")"
  runtime="$(resolve_protected_runtime "$instance")"
  verify_protected_home_acl "$instance"
  wait_for_service "fased-local-controller-$instance.service"
  wait_for_service "fased-signerd-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$version"
  wait_for_socket "/run/fased-local/$instance/operator/operator.sock"
  test "$(stat -c '%U:%G:%a' /opt/fased)" = "root:root:755"
  test "$(stat -c '%U:%G:%a' "$state")" = \
    "testop:fscf-$instance:2770"
  test "$(stat -c '%U:%G:%a' "$state/fased.json")" = \
    "testop:fscf-$instance:660"

  mapfile -t env_args < <(operator_env "$instance")
  runuser -u testop -- env "${env_args[@]}" \
    /usr/local/bin/node "$runtime/fased.mjs" health --json --timeout 5000 \
    >/tmp/fresh-pre-wallet-health.json
  jq -e '.ok == true' /tmp/fresh-pre-wallet-health.json >/dev/null
  verify_profileless_config_write "$instance" "$runtime"
  service_elapsed="$((SECONDS - service_started))"
  wallet_started="$SECONDS"
  for wallet_spec in "agent:Agent:agent" "vault:Vault:vault"; do
    IFS=: read -r wallet_id wallet_name wallet_role <<<"$wallet_spec"
    runuser -u testop -- env "${env_args[@]}" \
      /usr/local/bin/node "$runtime/fased.mjs" wallet setup \
      --mode local-signer-create \
      --wallet-id "$wallet_id" \
      --wallet-name "$wallet_name" \
      --role "$wallet_role" \
      --rpc-url "http://127.0.0.1:$rpc_port" \
      --non-interactive \
      --json \
      >"/tmp/fresh-${wallet_id}-create.json"
  done
  verify_wallet "$instance" agent >/tmp/fresh-agent.json
  verify_wallet "$instance" vault >/tmp/fresh-vault.json
  jq -e '.ready == true and .role == "agent"' /tmp/fresh-agent.json >/dev/null
  jq -e '.ready == true and .role == "vault"' /tmp/fresh-vault.json >/dev/null
  wait_for_gateway_version "$version"
  runuser -u testop -- env "${env_args[@]}" \
    /usr/local/bin/node "$runtime/fased.mjs" health --json --timeout 5000 \
    >/tmp/fresh-health.json
  jq -e '.ok == true' /tmp/fresh-health.json >/dev/null
  wallet_elapsed="$((SECONDS - wallet_started))"

  noop_started="$SECONDS"
  runuser -u testop -- env "${fresh_env[@]}" \
    "$state/bin/fased" update "${target_update_args[@]}" --timeout 30 \
    >/tmp/fresh-noop-update.out 2>/tmp/fresh-noop-update.err
  grep -F "Already current: $version" /tmp/fresh-noop-update.out >/dev/null
  if grep -F "Protected Local migration" /tmp/fresh-noop-update.err >/dev/null; then
    echo "fresh idempotent update repeated Protected Local migration" >&2
    exit 1
  fi
  noop_elapsed="$((SECONDS - noop_started))"

  restart_started="$SECONDS"
  systemctl restart "fased-local-controller-$instance.service" \
    "fased-signerd-$instance.service" "fased-gateway-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$version"
  runuser -u testop -- env "${env_args[@]}" \
    /usr/local/bin/node "$runtime/fased.mjs" health --json --timeout 5000 \
    >/tmp/fresh-restart-health.json
  jq -e '.ok == true' /tmp/fresh-restart-health.json >/dev/null
  ss -ltn | grep -Eq "127\\.0\\.0\\.1:${gateway_port}[[:space:]]"
  if ss -ltn | grep -Eq "(0\\.0\\.0\\.0|\\[::\\]):${gateway_port}[[:space:]]"; then
    echo "Fresh Protected Local Gateway is publicly bound." >&2
    exit 1
  fi
  restart_elapsed="$((SECONDS - restart_started))"

  agent_readiness_sha="$(jq -S -c . /tmp/fresh-agent.json | sha256sum | awk '{print $1}')"
  vault_readiness_sha="$(jq -S -c . /tmp/fresh-vault.json | sha256sum | awk '{print $1}')"
  key_sha="$(sha256sum "/var/lib/fased-local/$instance/signer/master.key" | awk '{print $1}')"
  jq -n \
    --arg instanceId "$instance" \
    --arg agentReadinessSha256 "$agent_readiness_sha" \
    --arg vaultReadinessSha256 "$vault_readiness_sha" \
    --arg masterKeySha256 "$key_sha" \
    '{
      instanceId: $instanceId,
      agentReadinessSha256: $agentReadinessSha256,
      vaultReadinessSha256: $vaultReadinessSha256,
      masterKeySha256: $masterKeySha256
    }' >"$snapshot"
  chmod 0600 "$snapshot"
  sed -n '/Fresh runtime timing:/,/  total:/p' /tmp/fresh-install.out || true
  printf 'fixture timing: phase=fresh-install prepare=%ss install=%ss services=%ss wallets=%ss noop=%ss restart=%ss total=%ss\n' \
    "$fresh_prepare_elapsed" \
    "$install_elapsed" \
    "$service_elapsed" \
    "$wallet_elapsed" \
    "$noop_elapsed" \
    "$restart_elapsed" \
    "$((SECONDS - fixture_started))"
  printf 'fresh Protected Local install, Gateway, and wallet fixture passed: %s\n' "$instance"
  exit 0
fi

# Install the complete immutable predecessor through its own released installer,
# application, dependency layer, signer, updater, and service setup. L1 must
# never manufacture a previous topology from current components.
# v0.1.75 requires gh to pre-exist because its immutable outer resolver installs
# verification tools inside command substitution. That historical fresh-install
# limitation is not repaired retroactively by the target candidate.
/usr/bin/install -m 0755 \
  /opt/fased-fixture-bootstrap-tools/gh /usr/local/bin/gh
legacy_channel="$([[ "$legacy_version" == *-* ]] && printf beta || printf stable)"
legacy_install_env=(
  HOME=/home/testop
  USER=testop
  LOGNAME=testop
  XDG_RUNTIME_DIR=/run/user/2000
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2000/bus
  FASED_STATE_DIR="$state"
  FASED_CONFIG_PATH="$state/fased.json"
  FASED_GATEWAY_PORT="$gateway_port"
  FASED_GATEWAY_TOKEN="$gateway_token"
  FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port"
  FASED_LOCAL_SIGNER_BASE_URL="http://127.0.0.1:$rpc_port"
  FASED_LOCAL_SIGNER_ALLOW_UNATTESTED=1
  FASED_INSTALL_REPO="$legacy_repo"
  FASED_FIXTURE_LEGACY_VERSION="$legacy_version"
  npm_config_registry="http://127.0.0.1:$rpc_port"
)
set +e
runuser -u testop -- env "${legacy_install_env[@]}" \
  /bin/bash -s -- \
    --release "v$legacy_version" \
    --update-channel "$legacy_channel" \
    --local \
    --install-dir /home/testop/fased \
    -- \
    --non-interactive \
    --accept-risk \
    --auth-choice skip \
    --workspace /home/testop/.fased/workspace \
    --gateway-auth token \
    --gateway-token "$gateway_token" \
    --gateway-port "$gateway_port" \
    --gateway-bind loopback \
    --wallet-enabled \
    --wallet-mode managed \
    --wallet-providers local-socket-signer \
    --wallet-default-provider local-socket-signer \
    --wallet-chains solana \
    --wallet-install-enabled \
    --skip-skills \
    --skip-health \
  <"$legacy_installer" \
  >/tmp/legacy-install.out 2>/tmp/legacy-install.err
legacy_install_status=$?
set -e
if [[ "$legacy_install_status" -ne 0 ]]; then
  test "$legacy_install_status" -eq 1
  grep -F "Installed stable Fased updater and activated managed runtime v${legacy_version}." \
    /tmp/legacy-install.out >/dev/null
  grep -F "Installed systemd service:" /tmp/legacy-install.out >/dev/null
fi

test "$(jq -er .profile "$state/install.json")" = "local"
test "$(jq -er .runtime.activeVersion "$state/install.json")" = "$legacy_version"
legacy_runtime="$(readlink -f "$state/runtime/current")"
test "$(jq -er .version "$legacy_runtime/package.json")" = "$legacy_version"
test "$(jq -er .version "$legacy_runtime/dist/build-info.json")" = "$legacy_version"
test "$(jq -er .commit "$legacy_runtime/dist/build-info.json")" = "$legacy_commit"
legacy_signer_env="$state/wallet/signer.env"
read_legacy_signer_env() {
  local key="$1"
  sed -n "s/^export ${key}=\"\\(.*\\)\"$/\\1/p" "$legacy_signer_env"
}
legacy_binary="$state/bin/fased-signerd"
legacy_socket="$(read_legacy_signer_env FASED_WALLET_LOCAL_SIGNER_SOCKET)"
legacy_control="$(read_legacy_signer_env FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET)"
legacy_db="$(read_legacy_signer_env FASED_WALLET_LOCAL_SIGNER_STATE_DB)"
legacy_master_key="$(read_legacy_signer_env FASED_WALLET_LOCAL_SIGNER_MASTER_KEY)"
test -n "$legacy_socket"
test -n "$legacy_control"
test -n "$legacy_db"
test -n "$legacy_master_key"
wallet_dir="$(dirname "$legacy_db")"
test "$(sha256sum "$legacy_binary" | awk '{print $1}')" = \
  "$(jq -er '.signer.platforms["linux-amd64"].sha256' \
    /legacy-artifacts/fased-hosted-release-v2.json)"
wait_for_socket "$legacy_control"
wait_for_gateway_version "$legacy_version"

legacy_cli="$state/install-cache/npm-global/bin/fased"
runuser -u testop -- env "${legacy_install_env[@]}" \
  "$legacy_cli" wallet setup \
    --mode local-signer-create \
    --wallet-id agent \
    --wallet-name Agent \
    --role agent \
    --rpc-url "http://127.0.0.1:$rpc_port" \
    --non-interactive \
    --json \
  >/tmp/legacy-wallet.json
legacy_public_key="$(jq -er '.address // .wallet.publicKey' /tmp/legacy-wallet.json)"

verify_legacy_wallet() {
  local output="$1"
  local error_output="${output}.err"
  for _ in {1..200}; do
    if [[ -S "$legacy_control" ]] &&
      runuser -u testop -- "$legacy_binary" admin wallet readiness \
        --control-socket "$legacy_control" \
        --wallet-id agent \
        >"$output" 2>"$error_output" &&
      jq -e --arg publicKey "$legacy_public_key" \
        '.ready == true and .role == "agent" and .publicKey == $publicKey' \
        "$output" >/dev/null; then
      rm -f -- "$error_output"
      return 0
    fi
    sleep 0.1
  done
  cat "$error_output" >&2 || true
  return 1
}
verify_legacy_wallet /tmp/legacy-readiness.json

original_key_sha="$(sha256sum "$legacy_master_key" | awk '{print $1}')"
original_registry_sha="$(sha256sum "$wallet_dir/provider-registry.v1.json" | awk '{print $1}')"
managed_update_env=(
  HOME=/home/testop \
  USER=testop \
  LOGNAME=testop \
  XDG_RUNTIME_DIR=/run/user/2000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2000/bus \
  FASED_STATE_DIR="$state" \
  FASED_CONFIG_PATH="$state/fased.json" \
  FASED_GATEWAY_PORT="$gateway_port" \
  FASED_GATEWAY_TOKEN="$gateway_token" \
  FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
  FASED_FIXTURE_LEGACY_VERSION="$legacy_version" \
  npm_config_registry="http://127.0.0.1:$rpc_port"
)
standard_bootstrap_env=(
  "${managed_update_env[@]}"
  FASED_INSTALL_REPO="$candidate_repo"
)

run_standard_local_bootstrap() {
  runuser -u testop -- env "${standard_bootstrap_env[@]}" \
    /bin/bash "$candidate_installer" \
    --release "v$version" \
    --update-channel "$([[ "$version" == *-* ]] && printf beta || printf stable)" \
    --local
}

# A pre-handoff executable cannot be changed retroactively. Exercise the
# version-neutral product contract instead: the normal verified Local installer
# detects the topology and performs one state-preserving protected bootstrap.
# Every subsequent transition uses only `fased update`.
prepare_restrictive_home_acl
original_home_acl="$(capture_home_acl)"
legacy_gateway_version="$legacy_version"
user_unit_dir=/home/testop/.config/systemd/user
test -s "$user_unit_dir/fased-gateway.service"
cat >"$user_unit_dir/fased-fixture-gateway-reactivator.service" <<'EOF_REACTIVATOR_SERVICE'
[Unit]
Description=Fased fixture legacy Gateway reverse dependency
After=fased-gateway.service
Wants=fased-gateway.service

[Service]
Type=oneshot
ExecStart=/usr/bin/true
EOF_REACTIVATOR_SERVICE
cat >"$user_unit_dir/fased-fixture-gateway-reactivator.timer" <<'EOF_REACTIVATOR_TIMER'
[Unit]
Description=Repeatedly exercise the legacy Gateway reverse dependency

[Timer]
OnBootSec=1
OnUnitActiveSec=1
Unit=fased-fixture-gateway-reactivator.service

[Install]
WantedBy=timers.target
EOF_REACTIVATOR_TIMER
chown testop:testop \
  "$user_unit_dir/fased-fixture-gateway-reactivator.service" \
  "$user_unit_dir/fased-fixture-gateway-reactivator.timer"
chmod 0600 "$user_unit_dir"/*.service "$user_unit_dir"/*.timer
user_systemctl daemon-reload
user_systemctl enable --now fased-fixture-gateway-reactivator.timer
wait_for_gateway_version "$legacy_gateway_version"
original_manifest_sha="$(sha256sum "$state/install.json" | awk '{print $1}')"
install -d -m 0700 -o testop -g testop "$state/identity"
cat >"$state/identity/device-auth.json" <<'EOF_LEGACY_DEVICE_AUTH'
{
  "version": 1,
  "deviceId": "fixture-shared-device",
  "tokens": {
    "operator": {
      "token": "fixture-operator-token",
      "role": "operator",
      "scopes": [],
      "updatedAtMs": 1
    }
  }
}
EOF_LEGACY_DEVICE_AUTH
chown testop:testop "$state/identity/device-auth.json"
chmod 0600 "$state/identity/device-auth.json"
printf '%s\n' "$version" >"$selected_target"

inject_failed_target_gateway() {
  local candidate=""
  local candidate_relative=""
  local fault_digest=""
  local fault_launcher=""
  local instance_id=""
  for _ in {1..12000}; do
    for candidate in /opt/fased/local/*/gateway-launch; do
      [[ -f "$candidate" ]] || continue
      candidate_relative="${candidate#/opt/fased/local/}"
      instance_id="${candidate_relative%%/*}"
      [[ -n "$instance_id" && "$instance_id" != "$candidate_relative" ]] || continue
      printf '%s\n' "$instance_id" >/tmp/injected-failure-instance
      fault_launcher="${candidate}.fixture-fault.$$"
      cat >"$fault_launcher" <<EOF_FAILED_GATEWAY
#!/usr/bin/env bash
set -euo pipefail
export FASED_FIXTURE_GATEWAY_PORT=$gateway_port
export FASED_FIXTURE_LEGACY_VERSION=$legacy_gateway_version
exec /usr/local/bin/node /usr/local/libexec/fased-fixture-legacy-gateway.mjs
EOF_FAILED_GATEWAY
      chown root:root "$fault_launcher"
      chmod 0755 "$fault_launcher"
      mv -f "$fault_launcher" "$candidate"
      fault_digest="$(sha256sum "$candidate" | awk '{print $1}')"
      for _ in {1..12000}; do
        [[ -f "$candidate" ]] || break
        if [[ "$(sha256sum "$candidate" | awk '{print $1}')" != "$fault_digest" ]]; then
          fault_launcher="${candidate}.fixture-fault.$$"
          cat >"$fault_launcher" <<EOF_FAILED_GATEWAY
#!/usr/bin/env bash
set -euo pipefail
export FASED_FIXTURE_GATEWAY_PORT=$gateway_port
export FASED_FIXTURE_LEGACY_VERSION=$legacy_gateway_version
exec /usr/local/bin/node /usr/local/libexec/fased-fixture-legacy-gateway.mjs
EOF_FAILED_GATEWAY
          chown root:root "$fault_launcher"
          chmod 0755 "$fault_launcher"
          mv -f "$fault_launcher" "$candidate"
          return 0
        fi
        sleep 0.005
      done
      echo "failed to inject the staged target Gateway activation fault" >&2
      return 1
    done
    sleep 0.01
  done
  echo "failed to inject the target Gateway activation fault" >&2
  return 1
}

inject_failed_target_gateway &
injector_pid=$!
if run_standard_local_bootstrap \
  >/tmp/protected-bootstrap-failure.out 2>/tmp/protected-bootstrap-failure.err; then
  update_failure_status=0
else
  update_failure_status=$?
fi
wait "$injector_pid"
test "$update_failure_status" -ne 0
grep -F "target release failed and was rolled back" /tmp/protected-bootstrap-failure.err >/dev/null
grep -F \
  "target Gateway did not become healthy as v${version}:" \
  /tmp/protected-bootstrap-failure.err >/dev/null
grep -F \
  "target Gateway readiness response is invalid" \
  /tmp/protected-bootstrap-failure.err >/dev/null
failure_instance="$(cat /tmp/injected-failure-instance)"
wait_for_gateway_version "$legacy_gateway_version"
verify_original_home_acl
test ! -e "$user_unit_dir/fased-gateway.service.d/90-fased-protected-local.conf"
test ! -e "/var/lib/fased-local/$failure_instance/controller/protected-local-active"
test ! -e "/var/lib/fased-local/$failure_instance"
test ! -e "/opt/fased/local/$failure_instance"
user_systemctl is-enabled --quiet fased-gateway.service
user_systemctl is-active --quiet fased-gateway.service
test "$(sha256sum "$state/install.json" | awk '{print $1}')" = "$original_manifest_sha"
test "$(sha256sum "$legacy_master_key" | awk '{print $1}')" = "$original_key_sha"
test "$(sha256sum "$wallet_dir/provider-registry.v1.json" | awk '{print $1}')" = \
  "$original_registry_sha"
verify_legacy_wallet /tmp/failure-rollback-agent.json

run_standard_local_bootstrap \
  >/tmp/protected-bootstrap.out 2>/tmp/protected-bootstrap.err
grep -F "Verified Local lifecycle handoff complete." /tmp/protected-bootstrap.out >/dev/null
grep -F "Pre-handoff Local installation detected" /tmp/protected-bootstrap.err >/dev/null

instance="$(jq -er '.env.vars.FASED_PROTECTED_LOCAL_INSTANCE' "$state/fased.json")"
runtime="$(resolve_protected_runtime "$instance")"
verify_protected_home_acl "$instance"
wait_for_gateway_version "$version"
wait_for_service "fased-signerd-$instance.service"
wait_for_service "fased-local-controller-$instance.service"
wait_for_service "fased-gateway-$instance.service"
test "$(stat -c '%U:%G:%a' "$state/identity/device-auth.json")" = \
  "testop:fscf-$instance:660"
verify_shared_device_auth "$instance" "$runtime"
verify_mining_history
verify_shared_federation_state "$instance" "$runtime"
verify_profileless_config_write "$instance" "$runtime"
signer_pid_before="$(systemctl show -p MainPID --value "fased-signerd-$instance.service")"
gateway_pid_before="$(systemctl show -p MainPID --value "fased-gateway-$instance.service")"
test "$(run_as_stale_operator id -G)" = "$(id -g testop)"
run_as_stale_operator test -r "$state/fased.json"
run_as_stale_operator "$state/bin/fased" update "${target_update_args[@]}" --timeout 30 \
  >/tmp/protected-stale-session-update.out 2>/tmp/protected-stale-session-update.err
grep -F "Already current: $version" /tmp/protected-stale-session-update.out >/dev/null
run_as_stale_operator "$state/bin/fased" mining history \
  --url "ws://127.0.0.1:$gateway_port" \
  --token "$gateway_token" \
  --timeout 5000 \
  --json \
  >/tmp/protected-stale-session-mining.json
jq -e 'type == "object"' /tmp/protected-stale-session-mining.json >/dev/null
runuser -u testop -- env "${managed_update_env[@]}" \
  "$state/bin/fased" update "${target_update_args[@]}" --timeout 30 \
  >/tmp/protected-noop-update.out 2>/tmp/protected-noop-update.err
grep -F "Already current: $version" /tmp/protected-noop-update.out >/dev/null
if grep -F "Protected Local migration" /tmp/protected-noop-update.err >/dev/null; then
  echo "idempotent update repeated Protected Local migration" >&2
  exit 1
fi
test "$(systemctl show -p MainPID --value "fased-signerd-$instance.service")" = \
  "$signer_pid_before"
test "$(systemctl show -p MainPID --value "fased-gateway-$instance.service")" = \
  "$gateway_pid_before"
runuser -u "fsgw-$instance" -- test -S \
  "/run/fased-local/$instance/application/app.sock"
test "$(jq -r .profile "$state/install.json")" = "protected-local"
test "$(jq -r .runtime.activeVersion "$state/install.json")" = "$version"
test "$(jq -r .runtime.previousVersion "$state/install.json")" = "$legacy_gateway_version"
test "$(jq -r .service.name "$state/install.json")" = "fased-gateway-$instance.service"
test "$(cat "/var/lib/fased-local/$instance/controller/signer-version")" = "$version"
test "$(jq -r .version "/var/lib/fased-local/$instance/controller/controller-version.json")" = \
  "$version"
test -s "/var/lib/fased-local/$instance/controller/protected-local-active"
test -s \
  "$user_unit_dir/fased-gateway.service.d/90-fased-protected-local.conf"
if user_systemctl is-active --quiet fased-gateway.service; then
  echo "legacy user Gateway remained active after protected Local migration" >&2
  exit 1
fi
user_systemctl start fased-fixture-gateway-reactivator.service
sleep 1
if user_systemctl is-active --quiet fased-gateway.service; then
  echo "legacy user Gateway was resurrected by a reverse dependency" >&2
  exit 1
fi
wait_for_gateway_version "$version"
verify_wallet "$instance" agent >/tmp/active-agent.json
jq -e --arg publicKey "$legacy_public_key" \
  '.ready == true and .role == "agent" and .publicKey == $publicKey' \
  /tmp/active-agent.json >/dev/null
test ! -e "$legacy_db"
test ! -e "$legacy_master_key"
test "$(sha256sum "$wallet_dir/provider-registry.v1.json" | awk '{print $1}')" = \
  "$original_registry_sha"

mapfile -t env_args < <(operator_env "$instance")
verify_shared_device_auth "$instance" "$runtime"
verify_mining_history
verify_shared_federation_state "$instance" "$runtime"
runuser -u testop -- env "${env_args[@]}" \
  /usr/local/bin/node "$runtime/fased.mjs" wallet setup \
  --mode local-signer-create \
  --wallet-id vault \
  --wallet-name Vault \
  --role vault \
  --rpc-url "http://127.0.0.1:$rpc_port" \
  --non-interactive \
  --json \
  >/tmp/protected-vault-create.json
verify_shared_wallet_registry "$instance" "$runtime"
verify_wallet "$instance" vault >/tmp/active-vault.json
jq -e '.ready == true and .role == "vault"' /tmp/active-vault.json >/dev/null
runuser -u testop -- "/opt/fased/local/$instance/signer/fased-signerd" \
  admin wallet balance \
  --operator-socket "/run/fased-local/$instance/operator/operator.sock" \
  --wallet-id agent \
  >/tmp/active-agent-balance.json
jq -e '.balance == "2000000000" and .unit == "lamports"' \
  /tmp/active-agent-balance.json >/dev/null

verify_supervised_controller_a_to_b "$instance"

systemctl restart "fased-local-controller-$instance.service" \
  "fased-signerd-$instance.service" "fased-gateway-$instance.service"
wait_for_service "fased-gateway-$instance.service"
wait_for_gateway_version "$version"
runuser -u testop -- env "${env_args[@]}" \
  /usr/local/bin/node "$runtime/fased.mjs" health --json --timeout 5000 \
  >/tmp/restart-health.json
jq -e '.ok == true' /tmp/restart-health.json >/dev/null
ss -ltn | grep -Eq "127\\.0\\.0\\.1:${gateway_port}[[:space:]]"
if ss -ltn | grep -Eq "(0\\.0\\.0\\.0|\\[::\\]):${gateway_port}[[:space:]]"; then
  echo "Protected Local Gateway is publicly bound." >&2
  exit 1
fi

verify_wallet "$instance" agent >/tmp/pre-reboot-agent.json
verify_wallet "$instance" vault >/tmp/pre-reboot-vault.json
agent_readiness_sha="$(jq -S -c . /tmp/pre-reboot-agent.json | sha256sum | awk '{print $1}')"
vault_readiness_sha="$(jq -S -c . /tmp/pre-reboot-vault.json | sha256sum | awk '{print $1}')"
key_sha="$(sha256sum "/var/lib/fased-local/$instance/signer/master.key" | awk '{print $1}')"
jq -n \
  --arg instanceId "$instance" \
  --arg agentReadinessSha256 "$agent_readiness_sha" \
  --arg vaultReadinessSha256 "$vault_readiness_sha" \
  --arg masterKeySha256 "$key_sha" \
  --arg agentPublicKey "$legacy_public_key" \
  '{
    instanceId: $instanceId,
    agentReadinessSha256: $agentReadinessSha256,
    vaultReadinessSha256: $vaultReadinessSha256,
    masterKeySha256: $masterKeySha256,
    agentPublicKey: $agentPublicKey
  }' >"$snapshot"
chmod 0600 "$snapshot"

printf 'protected Local real Gateway and wallet fixture passed: %s\n' "$instance"
