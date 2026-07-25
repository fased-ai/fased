#!/usr/bin/env bash
set -euo pipefail

phase="${1:-install}"
version="${FASED_FIXTURE_VERSION:?missing fixture version}"
commit="${FASED_FIXTURE_COMMIT:?missing fixture commit}"
digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
release_root="/var/lib/fased-installer/releases/v${version}/${digest}/extract/package"
root_store="$(dirname "$(dirname "$release_root")")"
state=/home/testop/.fased
runtime="$state/runtime/releases/$version"
gateway_port=19456
rpc_port=19457
gateway_token=fased-protected-local-fixture-token
snapshot=/var/lib/fased-protected-local-fixture.json

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

if [[ "$phase" == "verify-reboot" ]]; then
  [[ -f "$snapshot" ]]
  instance="$(jq -er .instanceId "$snapshot")"
  wait_for_service "fased-local-controller-$instance.service"
  wait_for_service "fased-signerd-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_socket "/run/fased-local/$instance/operator/operator.sock"
  mapfile -t env_args < <(operator_env "$instance")
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
  printf 'protected Local reboot fixture passed: %s\n' "$instance"
  exit 0
fi

[[ "$phase" == "install" ]] || {
  echo "usage: fased-protected-local-systemd-fixture install|verify-reboot" >&2
  exit 64
}

useradd --uid 2000 --user-group --create-home --shell /bin/bash testop
install -d -m 0700 -o testop -g testop "$state"
install -d -m 0755 -o testop -g testop "$(dirname "$runtime")"
# Reproduce a previous root bootstrap that created only its final child with a
# restrictive umask, leaving the shared executable ancestor non-traversable to
# the isolated signer account.
install -d -m 0700 -o root -g root /opt/fased
install -d -m 0755 -o root -g root "$release_root/scripts" "$release_root/dist"
install -d -m 0755 -o root -g root \
  "$root_store/verified-assets" \
  "$root_store/verified-dependencies"

runtime_asset="/artifacts/fased-hosted-linux-x64-v${version}.tar.gz"
[[ -f "$runtime_asset" ]]
install -d -m 0755 "$runtime"
tar -xzf "$runtime_asset" -C "$runtime" --strip-components=1
chown -R testop:testop "$runtime"
cp -a "$runtime/." "$release_root/"
cp -a "$runtime/node_modules" "$root_store/verified-dependencies/node_modules"
rm -rf "$release_root/node_modules"

for script in fased-host-updater.mjs fased-host-updaterctl.mjs fased-signer-owner-hosting.sh; do
  install -m 0755 -o root -g root "/repo/scripts/$script" "$release_root/scripts/$script"
done
install -m 0755 -o root -g root /repo/dist-native/release/fased-signerd-linux-amd64 \
  "$root_store/verified-assets/fased-signerd"

signer_sha="$(sha256sum "$root_store/verified-assets/fased-signerd" | awk '{print $1}')"
dependency_hash="$(jq -er '.dependencyHash' "$release_root/.fased-hosted-runtime.json")"
printf 'version=%s\ncommit=%s\nsigner_sha256=%s\ndependency_sha256=%s\ndependency_hash=%s\n' \
  "$version" "$commit" "$signer_sha" "$(printf fixture | sha256sum | awk '{print $1}')" "$dependency_hash" \
  >"$release_root/.fased-hosting-bundle-verified"
chmod 0600 "$release_root/.fased-hosting-bundle-verified"
printf '{"name":"@fased/fased","version":"%s"}\n' "$version" >"$release_root/package.json"
printf '{"version":"%s","commit":"%s"}\n' "$version" "$commit" \
  >"$release_root/dist/build-info.json"
chown -R root:root "$release_root" "$root_store/verified-assets" "$root_store/verified-dependencies"
chmod -R a+rX,go-w "$release_root" "$root_store/verified-assets" "$root_store/verified-dependencies"
chmod 0600 "$release_root/.fased-hosting-bundle-verified"

install -d -m 0755 /usr/local/libexec
cat >/usr/local/libexec/fased-fixture-solana-rpc.mjs <<'EOF_RPC'
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const port = Number(process.env.FASED_FIXTURE_RPC_PORT);
const version = process.env.FASED_FIXTURE_VERSION;
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // pragma: allowlist secret
http.createServer((request, response) => {
  if (request.method === "GET" && request.url?.startsWith("/@fased%2ffased")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ "dist-tags": { latest: version, beta: version } }));
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
        : path.join("/artifacts", asset);
    try {
      const stat = fs.statSync(selected);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-length": stat.size });
      fs.createReadStream(selected).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
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
}).listen(port, "127.0.0.1");
EOF_RPC
cat >/usr/local/libexec/fased-fixture-protected-installer.sh <<EOF_PROTECTED_INSTALLER
#!/usr/bin/env bash
set -euo pipefail
declare -A values=()
while [[ "\$#" -gt 0 ]]; do
  case "\$1" in
    --protected-local-root-bootstrap) shift ;;
    --*) values["\$1"]="\${2:-}"; shift 2 ;;
    *) echo "unexpected fixture installer argument: \$1" >&2; exit 64 ;;
  esac
done
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
  --gateway-health-timeout-ms "\${values[--protected-local-gateway-health-timeout-ms]}"
EOF_PROTECTED_INSTALLER
chmod 0755 /usr/local/libexec/fased-fixture-protected-installer.sh
cat >/etc/systemd/system/fased-fixture-solana-rpc.service <<EOF_RPC_UNIT
[Unit]
Description=Fased fixture Solana RPC

[Service]
Type=simple
Environment=FASED_FIXTURE_RPC_PORT=$rpc_port
Environment=FASED_FIXTURE_VERSION=$version
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

wallet_dir="$state/wallet"
legacy_binary="$state/bin/fased-signerd"
legacy_socket="$wallet_dir/local-signer.sock"
legacy_control="$wallet_dir/local-signer-control.sock"
install -d -m 0700 -o testop -g testop "$wallet_dir" "$(dirname "$legacy_binary")"
install -m 0700 -o testop -g testop "$root_store/verified-assets/fased-signerd" "$legacy_binary"
ln "$legacy_binary" "$state/bin/fased-signer-enroll"
start_legacy_signer() {
  runuser -u testop -- "$legacy_binary" \
    -socket "$legacy_socket" \
    -control-socket "$legacy_control" \
    -socket-mode 0600 \
    -application-uid 2000 \
    -operator-uid 2000 \
    -control-uid 2000 \
    -state-db "$wallet_dir/signerd-v2.db" \
    -master-key "$wallet_dir/signerd-v2.master.key" \
    -pid-file "$wallet_dir/local-signer.pid" \
    -audit-log "$wallet_dir/local-signer.audit.jsonl" \
    >/tmp/legacy-signer.log 2>&1 &
  if ! wait_for_socket "$legacy_control"; then
    cat /tmp/legacy-signer.log >&2 || true
    return 1
  fi
}

stop_legacy_signer() {
  local pid=""
  pid="$(cat "$wallet_dir/local-signer.pid")"
  kill "$pid"
  for _ in {1..200}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$legacy_socket" "$legacy_control" "$wallet_dir/local-signer.pid"
      return 0
    fi
    sleep 0.1
  done
  echo "legacy Local signer did not stop cleanly" >&2
  return 1
}

verify_legacy_wallet() {
  local output="$1"
  start_legacy_signer
  runuser -u testop -- "$legacy_binary" admin wallet readiness \
    --control-socket "$legacy_control" \
    --wallet-id agent \
    >"$output"
  jq -e --arg publicKey "$legacy_public_key" \
    '.ready == true and .role == "agent" and .publicKey == $publicKey' \
    "$output" >/dev/null
  stop_legacy_signer
}

start_legacy_signer
runuser -u testop -- "$legacy_binary" admin wallet create \
  --control-socket "$legacy_control" \
  --wallet-id agent \
  --baseline-role agent \
  >/tmp/legacy-wallet.json
printf '{"primaryRpcUrl":"http://127.0.0.1:%s"}\n' "$rpc_port" |
  runuser -u testop -- "$legacy_binary" admin network set-primary \
    --control-socket "$legacy_control" \
    --wallet-id agent \
    --expected-version 0 \
    >/tmp/legacy-network.json
stop_legacy_signer
legacy_public_key="$(jq -er '.wallet.publicKey' /tmp/legacy-wallet.json)"
cat >"$wallet_dir/provider-registry.v1.json" <<EOF_REGISTRY
{
  "version": 1,
  "wallets": [
    {
      "id": "agent",
      "name": "Agent",
      "providerId": "local-socket-signer",
      "addresses": { "solana": "$legacy_public_key" },
      "metadata": {
        "role": "agent",
        "purpose": "agent",
        "signerWalletId": "agent"
      }
    }
  ]
}
EOF_REGISTRY
cat >"$state/fased.json" <<EOF_CONFIG
{
  "gateway": {
    "port": $gateway_port,
    "auth": {
      "mode": "token",
      "token": "$gateway_token"
    }
  },
  "update": { "channel": "$([[ "$version" == *-* ]] && printf beta || printf stable)" },
  "discovery": { "mdns": { "mode": "off" } },
  "wallet": { "runtime": { "enabled": true } },
  "env": {
    "vars": {
      "FASED_WALLET_LOCAL_SIGNER_BIN": "$legacy_binary",
      "FASED_WALLET_LOCAL_SIGNER_SOCKET": "$legacy_socket",
      "FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET": "$legacy_control",
      "FASED_WALLET_LOCAL_SIGNER_STATE_DB": "$wallet_dir/signerd-v2.db",
      "FASED_WALLET_LOCAL_SIGNER_MASTER_KEY": "$wallet_dir/signerd-v2.master.key",
      "FASED_WALLET_SIGNER_STATE_DIR": "$wallet_dir",
      "FASED_WALLET_SOLANA_RPC_URL_AGENT": "http://127.0.0.1:$rpc_port"
    }
  }
}
EOF_CONFIG
cat >"$state/install.json" <<EOF_MANIFEST
{
  "schemaVersion": 2,
  "profile": "local",
  "stateDir": "$state",
  "configPath": "$state/fased.json",
  "runtime": {
    "activeVersion": "$version",
    "currentLink": "$state/runtime/current",
    "releasesDir": "$state/runtime/releases"
  },
  "service": {
    "name": "fased-gateway.service",
    "scope": "user",
    "launcher": "$runtime/scripts/start-managed.sh"
  },
  "updater": {
    "version": "$version",
    "path": "$state/updater/fased-managed-updater.mjs"
  }
}
EOF_MANIFEST
ln -s "$runtime" "$state/runtime/current"
chown -R testop:testop "$state"
chmod 0700 /home/testop

original_manifest_sha="$(sha256sum "$state/install.json" | awk '{print $1}')"
original_key_sha="$(sha256sum "$wallet_dir/signerd-v2.master.key" | awk '{print $1}')"

bootstrap prepare >/tmp/protected-prepare.json
instance="$(jq -er .instanceId /tmp/protected-prepare.json)"
test "$(stat -c '%U:%G:%a' /opt/fased)" = "root:root:755"
test -S "/run/fased-local/$instance/application/app.sock"
test -S "/run/fased-local/$instance/operator/operator.sock"
test -S "/run/fased-local/$instance/control/control.sock"
test "$(stat -c '%U:%G:%a' "/run/fased-local/$instance/operator/operator.sock")" = \
  "testop:fsop-$instance:600"
test "$(stat -c '%U:%G:%a' "/run/fased-local/$instance/control/control.sock")" = \
  "fssg-$instance:fssg-$instance:600"
test "$(stat -c '%U:%G:%a' "/run/fased-local/$instance/application/app.sock")" = \
  "fssg-$instance:fsgw-$instance:660"
verify_wallet "$instance" agent >/tmp/prepared-agent.json
jq -e --arg publicKey "$legacy_public_key" \
  '.ready == true and .role == "agent" and .publicKey == $publicKey' \
  /tmp/prepared-agent.json >/dev/null

bootstrap rollback >/tmp/protected-rollback.json
test ! -e "/etc/systemd/system/fased-gateway-$instance.service"
test ! -e "/etc/fased/local/$instance"
test ! -e "/var/lib/fased-local/$instance"
test ! -e "/opt/fased/local/$instance"
test "$(sha256sum "$state/install.json" | awk '{print $1}')" = "$original_manifest_sha"
test "$(sha256sum "$wallet_dir/signerd-v2.master.key" | awk '{print $1}')" = "$original_key_sha"
verify_legacy_wallet /tmp/rollback-agent.json
test "$(stat -c '%d:%i:%h' "$legacy_binary")" = \
  "$(stat -c '%d:%i:%h' "$state/bin/fased-signer-enroll")"
test "$(stat -c '%h' "$legacy_binary")" = "2"

install -d -m 0700 -o testop -g testop "$state/bin" "$state/updater"
for script in \
  fased-managed-updater.mjs \
  hosted-release-manifest.mjs \
  managed-runtime-layout.mjs; do
  install -m 0700 -o testop -g testop "$runtime/scripts/$script" "$state/updater/$script"
done
install -m 0700 -o testop -g testop \
  "$runtime/scripts/fased-managed-launcher.sh" "$state/bin/fased"
install -m 0700 -o testop -g testop \
  "$runtime/scripts/fased-managed-service.sh" "$state/bin/fased-service"
for directory in \
  "$state/install-cache" \
  "$state/install-cache/npm-global" \
  "$state/install-cache/npm-global/bin"; do
  install -d -m 0700 -o testop -g testop "$directory"
done
ln -s "$state/bin/fased" "$state/install-cache/npm-global/bin/fased"
cat >/etc/sudoers.d/fased-protected-local-fixture <<'EOF_SUDOERS'
testop ALL=(root) NOPASSWD: ALL
EOF_SUDOERS
chmod 0440 /etc/sudoers.d/fased-protected-local-fixture

managed_update_env=(
  HOME=/home/testop \
  FASED_STATE_DIR="$state" \
  FASED_CONFIG_PATH="$state/fased.json" \
  FASED_GATEWAY_PORT="$gateway_port" \
  FASED_GATEWAY_TOKEN="$gateway_token" \
  FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
  npm_config_registry="http://127.0.0.1:$rpc_port"
)

install -d -m 0755 -o root -g root /etc/fased/testing
cat >/etc/fased/testing/protected-local-artifact-source.json <<EOF_ARTIFACT_SOURCE
{
  "schemaVersion": 1,
  "baseUrl": "http://127.0.0.1:$rpc_port",
  "releaseVersion": "$version"
}
EOF_ARTIFACT_SOURCE
chmod 0444 /etc/fased/testing/protected-local-artifact-source.json

bootstrap prepare >/tmp/protected-failure-prepare.json
failure_instance="$(jq -er .instanceId /tmp/protected-failure-prepare.json)"
printf '#!/usr/bin/env bash\nexit 91\n' \
  >"/opt/fased/local/$failure_instance/application/current/scripts/start-managed.sh"
chmod 0755 "/opt/fased/local/$failure_instance/application/current/scripts/start-managed.sh"
set +e
bootstrap activate >/tmp/protected-failure.out 2>/tmp/protected-failure.err
failure_status=$?
set -e
test "$failure_status" -ne 0
test "$(sha256sum "$state/install.json" | awk '{print $1}')" = "$original_manifest_sha"
test "$(sha256sum "$wallet_dir/signerd-v2.master.key" | awk '{print $1}')" = "$original_key_sha"
test ! -e "/etc/systemd/system/fased-gateway-$failure_instance.service"
verify_legacy_wallet /tmp/failure-rollback-agent.json

runuser -u testop -- env "${managed_update_env[@]}" \
  "$state/install-cache/npm-global/bin/fased" update --timeout 60 \
  >/tmp/protected-update.out 2>/tmp/protected-update.err
grep -F "Protected Local migration" /tmp/protected-update.err >/dev/null
grep -F "Update mode: verified target-owned Protected Local transaction" \
  /tmp/protected-update.out >/dev/null

instance="$(jq -er '.env.vars.FASED_PROTECTED_LOCAL_INSTANCE' "$state/fased.json")"
wait_for_service "fased-signerd-$instance.service"
wait_for_service "fased-local-controller-$instance.service"
wait_for_service "fased-gateway-$instance.service"
signer_pid_before="$(systemctl show -p MainPID --value "fased-signerd-$instance.service")"
gateway_pid_before="$(systemctl show -p MainPID --value "fased-gateway-$instance.service")"
runuser -u testop -- env "${managed_update_env[@]}" \
  "$state/install-cache/npm-global/bin/fased" update --timeout 30 \
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
test "$(jq -r .service.name "$state/install.json")" = "fased-gateway-$instance.service"
test "$(cat "/var/lib/fased-local/$instance/controller/signer-version")" = "$version"
test "$(jq -r .version "/var/lib/fased-local/$instance/controller/controller-version.json")" = \
  "$version"
verify_wallet "$instance" agent >/tmp/active-agent.json
jq -e --arg publicKey "$legacy_public_key" \
  '.ready == true and .role == "agent" and .publicKey == $publicKey' \
  /tmp/active-agent.json >/dev/null
test ! -e "$wallet_dir/signerd-v2.db"
test ! -e "$wallet_dir/signerd-v2.master.key"

mapfile -t env_args < <(operator_env "$instance")
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
verify_wallet "$instance" vault >/tmp/active-vault.json
jq -e '.ready == true and .role == "vault"' /tmp/active-vault.json >/dev/null
runuser -u testop -- "/opt/fased/local/$instance/signer/fased-signerd" \
  admin wallet balance \
  --operator-socket "/run/fased-local/$instance/operator/operator.sock" \
  --wallet-id agent \
  >/tmp/active-agent-balance.json
jq -e '.balance == "2000000000" and .unit == "lamports"' \
  /tmp/active-agent-balance.json >/dev/null

systemctl restart "fased-local-controller-$instance.service" \
  "fased-signerd-$instance.service" "fased-gateway-$instance.service"
wait_for_service "fased-gateway-$instance.service"
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
