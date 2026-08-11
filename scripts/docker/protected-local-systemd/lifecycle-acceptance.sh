#!/usr/bin/env bash
set -euo pipefail
trap 'status=$?; printf "Local acceptance command failed at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2; exit "$status"' ERR

phase="${1:-fresh-install}"
fixture_started="$SECONDS"
version="${FASED_FIXTURE_VERSION:?missing fixture version}"
commit="${FASED_FIXTURE_COMMIT:?missing fixture commit}"
predecessor_version="${FASED_FIXTURE_PREDECESSOR_VERSION:-}"
preinstalled_tools="${FASED_FIXTURE_PREINSTALLED_TOOLS:-0}"
public_acquisition="${FASED_FIXTURE_PUBLIC_ACQUISITION:-0}"
acceptance_contract=/artifacts/fased-lifecycle-acceptance-v2.json
acceptance_descriptor=/artifacts/fased-hosting-candidate.json
acceptance_evidence="/tmp/fased-lifecycle-acceptance-${phase}.evidence.jsonl"
acceptance_receipt="/var/lib/fased-protected-local-fixture/lifecycle-acceptance-${phase}.json"
target_update_args=()
if [[ "$version" == *-* ]]; then
  target_update_args=(--channel beta)
fi
digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
release_root="/var/lib/fased-installer/releases/v${version}/${digest}/extract/package"
root_store="$(dirname "$(dirname "$release_root")")"
candidate_installer=/var/lib/fased-protected-local-install.sh
predecessor_capsule_descriptor=/predecessor-capsule/fased-predecessor-capsule.json
predecessor_capsule_attestation=/predecessor-capsule/fased-predecessor-capsule.json.attestation.json
predecessor_capsule_branch_proof=/predecessor-capsule/fased-predecessor-branch-proof.json
predecessor_capsule_authorization=/run/fased-predecessor-capsule-fixture-authorized
state=/home/testop/.fased
runtime="$state/runtime/releases/$version"
legacy_runtime="$state/runtime/releases/$predecessor_version"
gateway_port=19456
rpc_port=19457
gateway_token=fased-protected-local-fixture-token
snapshot=/var/lib/fased-protected-local-fixture.json
selected_target=/var/lib/fased-protected-local-fixture/selected-target-version
predecessor_target=/var/lib/fased-protected-local-fixture/predecessor-version
release_assets=/var/lib/fased-protected-local-fixture/release-assets
fixture_tls=/var/lib/fased-protected-local-fixture/tls
fixture_acl_user=fased-fixture-acl
fixture_acl_uid=2001

run_mount_has_option() {
  findmnt -n -o OPTIONS /run | tr ',' '\n' | grep -Fx "$1" >/dev/null
}

set_run_execution_policy() {
  local policy="$1"
  mount -o "remount,$policy" /run
  run_mount_has_option "$policy"
}

acceptance_mark() {
  local predicate="$1"
  local evidence_file="${2:-}"
  local summary="${3:-verified}"
  if [[ -z "$evidence_file" ]]; then
    evidence_file="/tmp/fased-lifecycle-${phase}-${predicate}.evidence"
    {
      systemctl list-units --all --no-pager 'fased-*' || true
      find /var/lib/fased-local /opt/fased/local -maxdepth 4 -type f -printf '%m %u:%g %s %p\n' 2>/dev/null || true
    } >"$evidence_file"
  fi
  test -s "$evidence_file"
  local evidence_digest=""
  evidence_digest="sha256:$(sha256sum "$evidence_file" | awk '{print $1}')"
  jq -cn \
    --arg id "$predicate" \
    --arg evidenceDigest "$evidence_digest" \
    --arg summary "$summary" \
    '{id:$id,status:"PASS",evidenceDigest:$evidenceDigest,summary:$summary}' \
    >>"$acceptance_evidence"
}

acceptance_start() {
  test "$public_acquisition" = "1"
  test -f "$acceptance_contract"
  test -f "$acceptance_descriptor"
  /usr/local/bin/node /fixture-tools/lifecycle-acceptance-contract.mjs validate \
    --contract "$acceptance_contract" >/dev/null
  : >"$acceptance_evidence"
  acceptance_mark artifact-identity "$acceptance_descriptor" "candidate descriptor verified"
  acceptance_mark public-installer-acquisition "$candidate_installer" "stamped public installer acquired"
  if [[ "$phase" == "managed-update" ]]; then
    predecessor_capsule_evidence="$predecessor_capsule_attestation"
    [[ -s "$predecessor_capsule_evidence" ]] || predecessor_capsule_evidence="$predecessor_capsule_branch_proof"
    acceptance_mark predecessor-capsule-attestation \
      "$predecessor_capsule_evidence" "predecessor capsule provenance verified"
  fi
}

acceptance_finish() {
  local descriptor_digest=""
  local capsule_digest=""
  local evidence_json="/tmp/fased-lifecycle-acceptance-${phase}.evidence.json"
  descriptor_digest="sha256:$(sha256sum "$acceptance_descriptor" | awk '{print $1}')"
  jq -s . "$acceptance_evidence" >"$evidence_json"
  if [[ "$phase" == "managed-update" ]]; then
    capsule_digest="sha256:$(sha256sum "$predecessor_capsule_descriptor" | awk '{print $1}')"
  fi
  /usr/local/bin/node /fixture-tools/lifecycle-acceptance-contract.mjs issue-receipt \
    --contract "$acceptance_contract" \
    --profile protected-local \
    --scenario "$phase" \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "$capsule_digest" \
    --evidence-file "$evidence_json" \
    --output "$acceptance_receipt"
  /usr/local/bin/node /fixture-tools/lifecycle-receipt-verifier.mjs \
    --contract "$acceptance_contract" \
    --receipt "$acceptance_receipt" \
    --profile protected-local \
    --scenario "$phase" \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "$capsule_digest" >/dev/null
}

verify_three_services() {
  local instance="$1"
  local unit=""
  for unit in \
    "fased-local-controller-$instance.service" \
    "fased-signerd-$instance.service" \
    "fased-gateway-$instance.service"; do
    wait_for_service "$unit"
    systemctl is-enabled --quiet "$unit"
    systemctl is-active --quiet "$unit"
  done
}

configure_fixture_sat_runtime() {
  local instance="$1"
  local dropin_dir="/etc/systemd/system/fased-gateway-$instance.service.d"

  install -d -m 0755 -o root -g root "$dropin_dir"
  cat >"$dropin_dir/95-fixture-sat-runtime.conf" <<'EOF_SAT_RUNTIME'
[Service]
Environment=FASED_SAT_PROGRAM_ID=11111111111111111111111111111111
Environment=FASED_SAT_BOND_PROGRAM_ID=ComputeBudget111111111111111111111111111111
Environment=FASED_SAT_MINT_ADDRESS=So11111111111111111111111111111111111111112
Environment=FASED_SAT_MINT_PROGRAM_ID=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
EOF_SAT_RUNTIME
  chmod 0644 "$dropin_dir/95-fixture-sat-runtime.conf"
  systemctl daemon-reload
  systemctl restart "fased-gateway-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$version"
}

run_operator_acceptance() {
  local instance="$1"
  local runtime_root="$2"
  local output_prefix="$3"
  local environment_name="$4"
  local -n environment="$environment_name"

  configure_fixture_sat_runtime "$instance"

  runuser -u testop -- env "${environment[@]}" \
    /usr/local/bin/node "$runtime_root/fased.mjs" wallet status --json \
    >"/tmp/${output_prefix}-wallet-status.json"
  jq -e \
    '.ok == true and (.status.wallets | length >= 2) and all(.status.wallets[]; .signer.ready == true)' \
    "/tmp/${output_prefix}-wallet-status.json" >/dev/null
  acceptance_mark wallet-status "/tmp/${output_prefix}-wallet-status.json" "wallet status verified"

  runuser -u testop -- env "${environment[@]}" \
    /usr/local/bin/node "$runtime_root/fased.mjs" wallet signer doctor --json \
    >"/tmp/${output_prefix}-wallet-signer-doctor.json"
  jq -e '.ok == true and all(.checks[]; .ok == true)' \
    "/tmp/${output_prefix}-wallet-signer-doctor.json" >/dev/null
  acceptance_mark wallet-signer-doctor "/tmp/${output_prefix}-wallet-signer-doctor.json" "wallet signer doctor verified"

  runuser -u testop -- env "${environment[@]}" \
    /usr/local/bin/node "$runtime_root/fased.mjs" mining status \
    --url "ws://127.0.0.1:$gateway_port" \
    --token "$gateway_token" \
    --timeout 5000 \
    --json >"/tmp/${output_prefix}-mining-status.json"
  jq -e 'type == "object"' "/tmp/${output_prefix}-mining-status.json" >/dev/null
  acceptance_mark mining-status "/tmp/${output_prefix}-mining-status.json" "mining status verified"

  runuser -u testop -- env "${environment[@]}" \
    /usr/local/bin/node "$runtime_root/fased.mjs" federation status --json \
    >"/tmp/${output_prefix}-network-status.json"
  jq -e 'type == "object"' "/tmp/${output_prefix}-network-status.json" >/dev/null
  acceptance_mark network-status "/tmp/${output_prefix}-network-status.json" "network status verified"

  runuser -u testop -- env "${environment[@]}" \
    /usr/local/bin/node "$runtime_root/fased.mjs" plugins doctor \
    >"/tmp/${output_prefix}-plugin-doctor.out"
  grep -F "No plugin issues detected." "/tmp/${output_prefix}-plugin-doctor.out" >/dev/null
  acceptance_mark plugin-doctor "/tmp/${output_prefix}-plugin-doctor.out" "plugin doctor verified"
}

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
  local signer_bin=""
  local fixture_sat_mint_program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" # pragma: allowlist secret
  signer_bin="$(resolve_signer_binary "$instance")"
  printf '%s\n' \
    "HOME=/home/testop" \
    "FASED_STATE_DIR=$state" \
    "FASED_CONFIG_PATH=$state/fased.json" \
    "FASED_GATEWAY_PORT=$gateway_port" \
    "FASED_GATEWAY_TOKEN=$gateway_token" \
    "FASED_SAT_PROGRAM_ID=11111111111111111111111111111111" \
    "FASED_SAT_BOND_PROGRAM_ID=ComputeBudget111111111111111111111111111111" \
    "FASED_SAT_MINT_ADDRESS=So11111111111111111111111111111111111111112" \
    "FASED_SAT_MINT_PROGRAM_ID=$fixture_sat_mint_program" \
    "FASED_HOST_PROFILE=local" \
    "FASED_LIFECYCLE_INSTALL_ROOT=/opt/fased/local/$instance" \
    "FASED_LIFECYCLE_INSTANCE=$instance" \
    "FASED_LIFECYCLE_PROFILE=protected-local" \
    "FASED_PROTECTED_LOCAL=1" \
    "FASED_PROTECTED_LOCAL_INSTANCE=$instance" \
    "FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external" \
    "FASED_WALLET_LOCAL_SIGNER_BIN=$signer_bin" \
    "FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-local/$instance/application/app.sock" \
    "FASED_HOST_UPDATER_SOCKET=/run/fased-local-controller/$instance/request.sock" \
    "FASED_HOST_UPDATERCTL_STATE=$state/protected-local-controller-transaction.json"
}

resolve_signer_binary() {
  local instance="$1"
  local managed="/opt/fased/local/$instance/current/payload/bin/fased-signerd"
  local predecessor="/opt/fased/local/$instance/signer/fased-signerd"
  if [[ -x "$managed" ]]; then
    printf '%s\n' "$managed"
    return
  fi
  # The fallback exists only so the fixture can construct the supported
  # public-stable predecessor before proving its one-way Go bridge.
  printf '%s\n' "$predecessor"
}

resolve_protected_runtime() {
  local instance="$1"
  local resolved=""
  resolved="$(readlink -f "/opt/fased/local/$instance/current/payload/runtime" 2>/dev/null || true)"
  case "$resolved" in
    "/opt/fased/local/$instance/generations/"*"/payload/runtime")
      printf '%s\n' "$resolved"
      return 0
      ;;
  esac
  resolved="$(readlink -f "$state/runtime/current")"
  case "$resolved" in
    "/opt/fased/local/$instance/application/releases/"*) printf '%s\n' "$resolved" ;;
    *)
      echo "Protected Local runtime selector escaped the root-controlled application store" >&2
      return 1
      ;;
  esac
}

resolve_predecessor_runtime() {
  local phase="$1"
  local instance="$2"
  test "$phase" = "managed-update"
  resolve_protected_runtime "$instance"
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
      FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
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
  federation_directory_identity="$(stat -c '%U:%G:%a' "$state/federation")"
  case "$federation_directory_identity" in
    "testop:fscf-$instance:2770"|"fsgw-$instance:fscf-$instance:2770") ;;
    *)
      echo "shared federation directory identity is unsafe: $federation_directory_identity" >&2
      return 1
      ;;
  esac
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

materialize_predecessor_wallet_registry_fixture() {
  local instance="$1"
  local runtime_root="$2"
  local module_url="file://$runtime_root/dist/wallet/wallet-provider-registry.js"
  local agent_address=""
  local vault_address=""
  local registry="$state/wallet/provider-registry.v1.json"
  local -a environment=()
  agent_address="$(jq -er .address /tmp/managed-agent-create.json)"
  vault_address="$(jq -er .address /tmp/managed-vault-create.json)"
  mapfile -t environment < <(operator_env "$instance")
  runuser -u testop -- env "${environment[@]}" \
    FASED_FIXTURE_MODULE_URL="$module_url" \
    FASED_FIXTURE_AGENT_ADDRESS="$agent_address" \
    FASED_FIXTURE_VAULT_ADDRESS="$vault_address" \
    /usr/local/bin/node --input-type=module --eval '
      const registry = await import(process.env.FASED_FIXTURE_MODULE_URL);
      for (const wallet of [
        { id: "agent", name: "Agent", role: "agent", address: process.env.FASED_FIXTURE_AGENT_ADDRESS },
        { id: "vault", name: "Vault", role: "vault", address: process.env.FASED_FIXTURE_VAULT_ADDRESS },
      ]) {
        registry.upsertNamedWallet({
          walletId: wallet.id,
          name: wallet.name,
          providerId: "local-socket-signer",
          addresses: { solana: wallet.address },
          metadata: {
            role: wallet.role,
            purpose: wallet.role,
            keyAuthority: "signer-owned-v2",
            signerWalletId: wallet.id,
          },
        });
      }
    '
  chown testop:"fscf-$instance" "$registry"
  chmod 0660 "$registry"
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
  printf 'Last Gateway health response: %s\n' "${response:-<unreachable>}" >&2
  ss -ltnp "sport = :$gateway_port" >&2 || true
  systemctl --no-pager --full status 'fased-gateway-*.service' >&2 || true
  user_systemctl --no-pager --full status fased-gateway.service >&2 || true
  return 1
}


verify_canonical_lifecycle_supervisor() {
  local instance="$1"
  local lifecycle_root="/var/lib/fased-local/$instance/lifecycle"
  local manifest="$lifecycle_root/installation-manifest.json"
  local supervisor_unit="fased-local-controller-$instance.service"
  local active_generation=""
  local active_root=""
  local committed_transactions=0
  local supervisor_journal=""
  local target_journal=""

  printf 'canonical lifecycle supervisor stage: manifest-and-pointer\n'
  active_generation="$(jq -er .activeGeneration.id "$manifest")"
  [[ "$active_generation" =~ ^sha256:[a-f0-9]{64}$ ]]
  jq -e --arg version "$version" --arg commit "$commit" \
    '.profile == "protected-local" and
     .activeGeneration.version == $version and
     .activeGeneration.commit == $commit' \
    "$manifest" >/dev/null
  active_root="$(readlink -f "/opt/fased/local/$instance/current")"
  test "$active_root" = "/opt/fased/local/$instance/generations/${active_generation#sha256:}"
  test -x /opt/fased/lifecycle/supervisor-v1/fased-lifecycled

  printf 'canonical lifecycle supervisor stage: unit-authority\n'
  systemctl cat "$supervisor_unit" >/tmp/canonical-supervisor-unit.txt
  grep -F \
    "ExecStart=/opt/fased/lifecycle/supervisor-v1/fased-lifecycled supervisor --config $lifecycle_root/platform.json --socket /run/fased-local-controller/$instance/request.sock" \
    /tmp/canonical-supervisor-unit.txt >/dev/null
  if grep -F " target " /tmp/canonical-supervisor-unit.txt >/dev/null; then
    echo "canonical lifecycle supervisor retained an external target process" >&2
    return 1
  fi
  systemctl is-active --quiet "$supervisor_unit"

  printf 'canonical lifecycle controller stage: authority-journals\n'
  while IFS= read -r supervisor_journal; do
    target_journal="${supervisor_journal%/supervisor.json}/target-controller.json"
    test -f "$target_journal"
    jq -e --slurpfile target "$target_journal" --arg generation "$active_generation" \
      '.transactionId == $target[0].transactionId and
       .target.id == $generation and
       $target[0].target.id == $generation and
       .phase == "COMMITTED" and
       $target[0].phase == "COMMITTED"' \
      "$supervisor_journal" >/dev/null || continue
    committed_transactions=$((committed_transactions + 1))
  done < <(find "$lifecycle_root/transactions" -mindepth 2 -maxdepth 2 \
    -type f -name supervisor.json -print)
  test "$committed_transactions" -ge 1
  printf 'canonical Go lifecycle supervisor transaction verified: %s\n' "$instance"
}

verify_wallet() {
  local instance="$1"
  local wallet_id="$2"
  runuser -u testop -- "$(resolve_signer_binary "$instance")" \
    admin wallet readiness \
    --operator-socket "/run/fased-local/$instance/operator/operator.sock" \
    --wallet-id "$wallet_id"
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
  verify_canonical_lifecycle_supervisor "$instance"
  test "$(resolve_signer_binary "$instance")" = \
    "/opt/fased/local/$instance/current/payload/bin/fased-signerd"
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

[[ "$phase" == "fresh-install" ||
  "$phase" == "managed-update" ]] || {
  echo "usage: fased-protected-local-systemd-fixture fresh-install|managed-update|verify-reboot" >&2
  exit 64
}
[[ "$public_acquisition" == "1" ]] || {
  echo "The Protected Local fixture requires an exact public-style artifact set." >&2
  exit 64
}
if [[ "$phase" != "fresh-install" &&
  ! "$predecessor_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "The update fixture requires an explicit predecessor version." >&2
  exit 64
fi

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

install -m 0755 -o root -g root /artifacts/fased-signerd-linux-amd64 \
  "$root_store/verified-assets/fased-signerd"

signer_sha="$(sha256sum "$root_store/verified-assets/fased-signerd" | awk '{print $1}')"
dependency_hash="$(jq -er '.dependencyHash' "$release_root/.fased-hosted-runtime.json")"
printf 'version=%s\ncommit=%s\nsigner_sha256=%s\ndependency_sha256=%s\ndependency_hash=%s\n' \
  "$version" "$commit" "$signer_sha" "$(printf fixture | sha256sum | awk '{print $1}')" "$dependency_hash" \
  >"$release_root/.fased-hosting-bundle-verified"
chmod 0600 "$release_root/.fased-hosting-bundle-verified"
test "$(jq -er .version "$release_root/package.json")" = "$version"

install -m 0700 -o testop -g testop /artifacts/install.sh "$candidate_installer"
if [[ "$phase" == "managed-update" ]]; then
  test -f "$predecessor_capsule_descriptor"
  test -s "$predecessor_capsule_attestation" || test -s "$predecessor_capsule_branch_proof"
  /usr/local/bin/node /fixture-tools/lifecycle-installed-state-capsule.mjs verify \
    --descriptor "$predecessor_capsule_descriptor" >/dev/null
fi

install -d -m 0700 -o root -g root /opt/fased-fixture-bootstrap-tools
install -m 0755 -o root -g root "$(command -v jq)" \
  /opt/fased-fixture-bootstrap-tools/jq

install -d -m 0755 -o root -g root /var/lib/fased-protected-local-fixture
app_asset="fased-hosted-app-v2-linux-x64-v${version}.tar.gz"
dependency_asset="$(basename "$(find /artifacts -maxdepth 1 -type f \
  -name 'fased-hosted-deps-linux-x64-*.tar.gz' -print -quit)")"
app_sha="$(sha256sum "/artifacts/$app_asset" | awk '{print $1}')"
dependency_sha="$(sha256sum "/artifacts/$dependency_asset" | awk '{print $1}')"
signer_build_input_digest="$(jq -er .buildInputDigest /artifacts/fased-signerd-release.json)"
if [[ "$public_acquisition" == "1" ]]; then
  install -m 0644 /artifacts/fased-hosted-release-v2.json \
    /var/lib/fased-protected-local-fixture/local-release-manifest.json
  install -m 0644 /artifacts/fased-hosted-release-v2.json.attestation.json \
    /var/lib/fased-protected-local-fixture/local-release-manifest.json.attestation.json
else
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
} from "/fixture-tools/build-hosted-release-manifest.mjs";

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
fi
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
  cp -a /artifacts/. "$release_assets/"

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
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"; // pragma: allowlist secret
const releaseAssets = "/var/lib/fased-protected-local-fixture/release-assets";
const releasePrefix = `/fased-ai/fased/releases/download/v${version}/`;
const metadataPrefix = `${releasePrefix}lifecycle/v1/`;

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
  if (request.method === "GET" && request.url?.startsWith(metadataPrefix)) {
    const metadata = request.url.slice(metadataPrefix.length);
    const selected = {
      "root.json": "fased-branch-root.json",
      "beta/delegation.json": "fased-branch-delegation.json",
      [`beta/v${version}/release-index.json`]: "fased-branch-release-index.json",
    }[metadata];
    if (!selected) {
      response.writeHead(404).end();
      return;
    }
    serveFile(response, path.join(releaseAssets, selected));
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
const version = process.env.FASED_FIXTURE_PREDECESSOR_VERSION;
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
cat >/usr/local/bin/sudo <<'EOF_SUDO_SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" apt-get "* || " $* " == *" dnf "* || " $* " == *" dnf5 "* ]]; then
  printf 'fixture package-manager progress before verified commit\n'
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  /usr/bin/sudo /usr/bin/install -m 0755 \
    /opt/fased-fixture-bootstrap-tools/jq /usr/local/bin/jq
  exit 0
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
Environment=FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor_version
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
if [[ "$phase" == "managed-update" ]]; then
  printf '%s\n' "$predecessor_version" >"$selected_target"
  printf '%s\n' "$predecessor_version" >"$predecessor_target"
else
  printf '%s\n' "$version" >"$selected_target"
  : >"$predecessor_target"
fi
chmod 0644 "$selected_target" "$predecessor_target"

if [[ "$phase" == "fresh-install" ]]; then
  fresh_prepare_elapsed="$((SECONDS - fixture_started))"
  if [[ "$preinstalled_tools" == "1" ]]; then
    install -m 0755 /opt/fased-fixture-bootstrap-tools/jq /usr/local/bin/jq
    command -v jq >/dev/null
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
    npm_config_registry="http://127.0.0.1:$rpc_port"
  )
  fresh_channel="$([[ "$version" == *-* ]] && printf beta || printf stable)"
  install_started="$SECONDS"
  runuser -u testop -- env "${fresh_env[@]}" \
    /bin/bash "$candidate_installer" \
      --release "v$version" \
      --update-channel "$fresh_channel" \
      --local \
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
  acceptance_start
  service_started="$SECONDS"
  test -s "$state/fased.json"
  test -s "$state/install.json"
  test "$(jq -r .profile "$state/install.json")" = "protected-local"
  instance="$(jq -er '.instanceId' "$state/lifecycle.json")"
  runtime="$(resolve_protected_runtime "$instance")"
  verify_protected_home_acl "$instance"
  verify_canonical_lifecycle_supervisor "$instance"
  acceptance_mark canonical-lifecycle
  verify_three_services "$instance"
  acceptance_mark three-services-active
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
  run_operator_acceptance "$instance" "$runtime" fresh env_args
  wallet_elapsed="$((SECONDS - wallet_started))"

  fresh_restart_manifest=/tmp/fresh-restart-preservation.sha256
  sha256sum \
    "$state/fased.json" \
    "$state/wallet/provider-registry.v1.json" \
    "/var/lib/fased-local/$instance/signer/master.key" \
    >"$fresh_restart_manifest"

  restart_started="$SECONDS"
  systemctl restart \
    "fased-local-controller-$instance.service" \
    "fased-signerd-$instance.service" \
    "fased-gateway-$instance.service"
  verify_three_services "$instance"
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
  acceptance_mark restart-health
  sha256sum --check "$fresh_restart_manifest"
  for wallet_id in agent vault; do
    verify_wallet "$instance" "$wallet_id" >"/tmp/fresh-${wallet_id}-restart.json"
    diff -u \
      <(jq -S . "/tmp/fresh-${wallet_id}.json") \
      <(jq -S . "/tmp/fresh-${wallet_id}-restart.json")
  done
  acceptance_mark state-preservation
  restart_elapsed="$((SECONDS - restart_started))"

  noop_started="$SECONDS"
  runuser -u testop -- env "${fresh_env[@]}" \
    /bin/bash "$candidate_installer" \
      --release "v$version" \
      --update-channel "$fresh_channel" \
      --local \
      --no-onboard \
    >/tmp/fresh-noop-installer.out 2>/tmp/fresh-noop-installer.err
  grep -F "Already current: $version" /tmp/fresh-noop-installer.out >/dev/null
  runuser -u testop -- env "${fresh_env[@]}" \
    "$state/bin/fased" update "${target_update_args[@]}" --timeout 120 \
    >/tmp/fresh-noop-update.out 2>/tmp/fresh-noop-update.err
  grep -F "Already current: $version" /tmp/fresh-noop-update.out >/dev/null
  if grep -F "Protected Local migration" /tmp/fresh-noop-update.err >/dev/null; then
    echo "fresh idempotent update repeated Protected Local migration" >&2
    exit 1
  fi
  acceptance_mark installer-already-current /tmp/fresh-noop-installer.out "Already current: $version"
  acceptance_mark updater-already-current /tmp/fresh-noop-update.out "Already current: $version"
  noop_elapsed="$((SECONDS - noop_started))"
  acceptance_finish

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

if [[ "$phase" == "managed-update" ]]; then
  managed_env=(
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
    npm_config_registry="http://127.0.0.1:$rpc_port"
  )
  predecessor_capsule_archive="$(jq -er .archive.name "$predecessor_capsule_descriptor")"
  printf 'fased-predecessor-capsule-fixture-v1\n' >"$predecessor_capsule_authorization"
  chown root:root "$predecessor_capsule_authorization"
  chmod 0600 "$predecessor_capsule_authorization"
  /usr/local/bin/node /fixture-tools/restore-predecessor-capsule.mjs restore \
    --descriptor "$predecessor_capsule_descriptor" \
    --archive "/predecessor-capsule/$predecessor_capsule_archive" \
    --root / \
    --authorization-marker "$predecessor_capsule_authorization" \
    --operator-uid "$(id -u testop)" \
    --operator-gid "$(id -g testop)" \
    --profile protected-local \
    >/tmp/managed-predecessor-capsule.out 2>/tmp/managed-predecessor-capsule.err
  rm -f "$predecessor_capsule_authorization"
  user_systemctl daemon-reload
  while IFS= read -r predecessor_service; do
    user_systemctl enable --now "$predecessor_service"
  done < <(jq -er '.services[]' "$predecessor_capsule_descriptor")
  run_mount_has_option noexec

  predecessor_profile="$(jq -er .profile "$state/install.json")"
  if [[ "$predecessor_profile" == "local" ]]; then
    user_systemctl is-enabled --quiet fased-gateway.service
    user_systemctl is-active --quiet fased-gateway.service
    wait_for_gateway_version "$predecessor_version"
    install -d -m 0700 -o testop -g testop \
      "$state/extensions" "$state/sat-mining" "$state/workspace"
    printf '{"schemaVersion":1,"enabled":["stable-bridge"]}\n' \
      >"$state/extensions/stable-bridge-plugin.json"
    printf '{"schemaVersion":1,"historyRevision":7}\n' \
      >"$state/sat-mining/stable-bridge-history.json"
    printf 'stable workspace state\n' >"$state/workspace/stable-bridge.txt"
    chown testop:testop \
      "$state/extensions/stable-bridge-plugin.json" \
      "$state/sat-mining/stable-bridge-history.json" \
      "$state/workspace/stable-bridge.txt"
    chmod 0600 \
      "$state/extensions/stable-bridge-plugin.json" \
      "$state/sat-mining/stable-bridge-history.json" \
      "$state/workspace/stable-bridge.txt"
    stable_bridge_manifest=/tmp/stable-bridge-preservation.sha256
    stable_bridge_restart_manifest=/tmp/stable-bridge-restart-preservation.sha256
    sha256sum \
      "$state/identity/device.json" \
      "$state/wallet/provider-registry.v1.json" \
      "$state/extensions/stable-bridge-plugin.json" \
      "$state/sat-mining/stable-bridge-history.json" \
      "$state/workspace/stable-bridge.txt" \
      >"$stable_bridge_manifest"
    sha256sum \
      "$state/identity/device.json" \
      "$state/extensions/stable-bridge-plugin.json" \
      "$state/sat-mining/stable-bridge-history.json" \
      "$state/workspace/stable-bridge.txt" \
      >"$stable_bridge_restart_manifest"
    acceptance_start

    run_stable_bridge_installer() {
      runuser -u testop -- env "${managed_env[@]}" \
        /bin/bash "$candidate_installer" \
        --release "v$version" \
        --update-channel beta \
        --local \
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
        --skip-health
    }

    bridge_fault_root="/var/tmp/fased-fixture-bridge-gateway-fault-$$"
    bridge_fault_script="$bridge_fault_root/reject-target.sh"
    bridge_fault_marker="$bridge_fault_root/injected"
    bridge_fault_dropin_dir=/etc/systemd/system/fased-gateway-.service.d
    bridge_fault_dropin="$bridge_fault_dropin_dir/99-fased-fixture-target-fault.conf"
    mkdir -p "$bridge_fault_root" "$bridge_fault_dropin_dir"
    cat >"$bridge_fault_script" <<EOF_STABLE_BRIDGE_FAILURE
#!/usr/bin/env bash
set -euo pipefail
unit="\${1:?unit is required}"
instance="\${unit#fased-gateway-}"
instance="\${instance%.service}"
printf '%s\n' "\$instance" >'$bridge_fault_marker'
exit 1
EOF_STABLE_BRIDGE_FAILURE
    chmod 0755 "$bridge_fault_script"
    cat >"$bridge_fault_dropin" <<EOF_STABLE_BRIDGE_DROPIN
[Service]
ExecStartPre=+$bridge_fault_script %n
EOF_STABLE_BRIDGE_DROPIN
    systemctl daemon-reload
    if run_stable_bridge_installer \
      >/tmp/stable-bridge-failure.out 2>/tmp/stable-bridge-failure.err; then
      stable_bridge_failure_status=0
    else
      stable_bridge_failure_status=$?
    fi
    rm -f "$bridge_fault_dropin"
    rmdir "$bridge_fault_dropin_dir" 2>/dev/null || true
    systemctl daemon-reload
    test "$stable_bridge_failure_status" -ne 0
    test -s "$bridge_fault_marker"
    grep -F "target release failed and was rolled back" /tmp/stable-bridge-failure.err >/dev/null
    failure_instance="$(cat "$bridge_fault_marker")"
    [[ "$failure_instance" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
    systemctl reset-failed "fased-gateway-$failure_instance.service" 2>/dev/null || true
    rm -rf -- "$bridge_fault_root"
    wait_for_gateway_version "$predecessor_version"
    test ! -e "$state/lifecycle.json"
    test ! -e "/var/lib/fased-local/$failure_instance"
    test ! -e "/opt/fased/local/$failure_instance"
    for failed_runtime_root in \
      "/run/fased-local/$failure_instance" \
      "/run/fased-local-controller/$failure_instance"; do
      test ! -e "$failed_runtime_root"
    done
    for failed_unit in \
      "fased-local-controller-$failure_instance.service" \
      "fased-signerd-$failure_instance.service" \
      "fased-gateway-$failure_instance.service"; do
      test ! -e "/etc/systemd/system/$failed_unit"
      ! systemctl is-enabled --quiet "$failed_unit"
    done
    if [[ -f /var/lib/fased-local-registry/instances.json ]]; then
      ! jq -e --arg instance "$failure_instance" \
        '.instances[]? | select(.instanceId == $instance)' \
        /var/lib/fased-local-registry/instances.json >/dev/null
    fi
    for failed_account in "fsgw-$failure_instance" "fssg-$failure_instance"; do
      ! getent passwd "$failed_account" >/dev/null
    done
    for failed_group in \
      "fsgw-$failure_instance" \
      "fssg-$failure_instance" \
      "fsop-$failure_instance" \
      "fscf-$failure_instance"; do
      ! getent group "$failed_group" >/dev/null
    done
    user_systemctl is-enabled --quiet fased-gateway.service
    user_systemctl is-active --quiet fased-gateway.service
    sha256sum --check "$stable_bridge_manifest"

    run_stable_bridge_installer \
      >/tmp/stable-bridge-update.out 2>/tmp/stable-bridge-update.err
    acceptance_mark rollback-retry
    test "$(jq -er .profile "$state/install.json")" = "protected-local"
    test "$(jq -er .runtime.activeVersion "$state/install.json")" = "$version"
    sha256sum --check "$stable_bridge_manifest"
    printf '%s\n' "$version" >"$selected_target"
    instance="$(jq -er .instanceId "$state/lifecycle.json")"
    runtime="$(resolve_protected_runtime "$instance")"
    mapfile -t managed_operator_env < <(operator_env "$instance")
    runuser -u "fsgw-$instance" -- test -r "$state/extensions/stable-bridge-plugin.json"
    verify_canonical_lifecycle_supervisor "$instance"
    acceptance_mark canonical-lifecycle
    verify_three_services "$instance"
    acceptance_mark three-services-active
    wait_for_gateway_version "$version"
    for wallet_spec in "agent:Agent:agent" "vault:Vault:vault"; do
      IFS=: read -r wallet_id wallet_name wallet_role <<<"$wallet_spec"
      runuser -u testop -- env "${managed_operator_env[@]}" \
        /usr/local/bin/node "$runtime/fased.mjs" wallet setup \
        --mode local-signer-create \
        --wallet-id "$wallet_id" \
        --wallet-name "$wallet_name" \
        --role "$wallet_role" \
        --rpc-url "http://127.0.0.1:$rpc_port" \
        --non-interactive \
        --json \
        >"/tmp/stable-${wallet_id}-create.json"
      verify_wallet "$instance" "$wallet_id" >"/tmp/stable-${wallet_id}.json"
    done
    run_operator_acceptance "$instance" "$runtime" stable managed_operator_env
    systemctl restart \
      "fased-local-controller-$instance.service" \
      "fased-signerd-$instance.service" \
      "fased-gateway-$instance.service"
    verify_three_services "$instance"
    wait_for_gateway_version "$version"
    acceptance_mark restart-health
    sha256sum --check "$stable_bridge_restart_manifest"
    verify_shared_wallet_registry "$instance" "$runtime"
    for wallet_id in agent vault; do
      verify_wallet "$instance" "$wallet_id" >"/tmp/stable-${wallet_id}-restart.json"
      diff -u \
        <(jq -S . "/tmp/stable-${wallet_id}.json") \
        <(jq -S . "/tmp/stable-${wallet_id}-restart.json")
    done
    acceptance_mark state-preservation
    if ! runuser -u testop -- env "${managed_operator_env[@]}" \
      npm_config_registry="http://127.0.0.1:$rpc_port" \
      FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
      "$state/bin/fased" update "${target_update_args[@]}" --timeout 120 \
      >/tmp/stable-bridge-noop.out 2>/tmp/stable-bridge-noop.err; then
      cat /tmp/stable-bridge-noop.err >&2
      exit 1
    fi
    grep -F "Already current: $version" /tmp/stable-bridge-noop.out >/dev/null
    run_stable_bridge_installer \
      >/tmp/stable-bridge-installer-noop.out 2>/tmp/stable-bridge-installer-noop.err
    grep -F "Already current: $version" /tmp/stable-bridge-installer-noop.out >/dev/null
    acceptance_mark installer-already-current /tmp/stable-bridge-installer-noop.out "Already current: $version"
    acceptance_mark updater-already-current /tmp/stable-bridge-noop.out "Already current: $version"
    acceptance_finish
    agent_readiness_sha="$(jq -S -c . /tmp/stable-agent-restart.json | sha256sum | awk '{print $1}')"
    vault_readiness_sha="$(jq -S -c . /tmp/stable-vault-restart.json | sha256sum | awk '{print $1}')"
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
    printf 'stable Local %s -> Protected Local %s verified installer bridge passed: %s\n' \
      "$predecessor_version" "$version" "$instance"
    exit 0
  fi
  test "$predecessor_profile" = "protected-local"
  test "$(jq -er .runtime.activeVersion "$state/install.json")" = "$predecessor_version"
  instance="$(jq -er '.env.vars.FASED_PROTECTED_LOCAL_INSTANCE' "$state/fased.json")"
  runtime="$(resolve_predecessor_runtime "$phase" "$instance")"
  mapfile -t managed_operator_env < <(operator_env "$instance")
  wait_for_service "fased-local-controller-$instance.service"
  wait_for_service "fased-signerd-$instance.service"
  wait_for_service "fased-gateway-$instance.service"
  wait_for_gateway_version "$predecessor_version"

  for wallet_spec in "agent:Agent:agent" "vault:Vault:vault"; do
    IFS=: read -r wallet_id wallet_name wallet_role <<<"$wallet_spec"
    runuser -u testop -- env "${managed_operator_env[@]}" \
      /usr/local/bin/node "$runtime/fased.mjs" wallet setup \
      --mode local-signer-create \
      --wallet-id "$wallet_id" \
      --wallet-name "$wallet_name" \
      --role "$wallet_role" \
      --rpc-url "http://127.0.0.1:$rpc_port" \
      --non-interactive \
      --json \
      >"/tmp/managed-${wallet_id}-create.json"
  done
  wait_for_gateway_version "$predecessor_version"
  verify_shared_device_auth "$instance" "$runtime"
  verify_shared_federation_state "$instance" "$runtime"
  wait_for_gateway_version "$predecessor_version"
  verify_mining_history
  materialize_predecessor_wallet_registry_fixture "$instance" "$runtime"
  verify_shared_wallet_registry "$instance" "$runtime"
  install -d -m 2770 -o testop -g "fscf-$instance" \
    "$state/sat-mining/wallets/agent" "$state/extensions"
  runuser -u testop -- env \
    FASED_FIXTURE_MINING_LEDGER="$state/sat-mining/wallets/agent/mining.sqlite" \
    /usr/local/bin/node --input-type=module <<'EOF_MANAGED_MINING_LEDGER'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.env.FASED_FIXTURE_MINING_LEDGER);
try {
  database.exec(
    "CREATE TABLE mining_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      "INSERT INTO mining_meta(key,value) VALUES('schema_version','1'),('history_revision','7');",
  );
} finally {
  database.close();
}
EOF_MANAGED_MINING_LEDGER
  printf '{"schemaVersion":1,"rpc":"fixture-rpc","policy":"agent"}\n' \
    >"$state/wallet/fixture-policy-rpc.json"
  printf '{"schemaVersion":1,"enabled":["fixture"]}\n' \
    >"$state/extensions/fixture-plugin-state.json"
  chown testop:"fscf-$instance" \
    "$state/sat-mining/wallets/agent/mining.sqlite" \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"
  chmod 0660 \
    "$state/sat-mining/wallets/agent/mining.sqlite" \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/extensions/fixture-plugin-state.json"
  verify_wallet "$instance" agent >/tmp/managed-agent-before.json
  verify_wallet "$instance" vault >/tmp/managed-vault-before.json
  jq -S '{nodeId, handle}' "$state/federation/access-token.json" \
    >/tmp/managed-federation-identity-before.json

  managed_state_manifest=/tmp/managed-update-preservation.sha256
  sha256sum \
    "$state/fased.json" \
    "$state/identity/device.json" \
    "$state/wallet/provider-registry.v1.json" \
    "$state/wallet/fixture-policy-rpc.json" \
    "$state/sat-mining/wallets/agent/mining.sqlite" \
    "$state/extensions/fixture-plugin-state.json" \
    "/var/lib/fased-local/$instance/signer/master.key" \
    >"$managed_state_manifest"
  verify_managed_state_manifest() {
    if ! sha256sum --check "$managed_state_manifest"; then
      echo "protected Local state changed outside a declared migration" >&2
      return 1
    fi
  }
  verify_managed_semantic_state() {
    local canonical_current="/opt/fased/local/$instance/current"
    local current_target=""
    verify_wallet "$instance" agent >/tmp/managed-agent-current.json
    verify_wallet "$instance" vault >/tmp/managed-vault-current.json
    diff -u \
      <(jq -S . /tmp/managed-agent-before.json) \
      <(jq -S . /tmp/managed-agent-current.json)
    diff -u \
      <(jq -S . /tmp/managed-vault-before.json) \
      <(jq -S . /tmp/managed-vault-current.json)
    diff -u \
      /tmp/managed-federation-identity-before.json \
      <(jq -S '{nodeId, handle}' "$state/federation/access-token.json")
    test "$(jq -er .runtime.currentLink "$state/install.json")" = "$canonical_current"
    current_target="$(readlink -f "$canonical_current")"
    [[ "$current_target" == "/opt/fased/local/$instance/generations/"* ]]
    test "$(jq -er .profile "$state/install.json")" = "protected-local"
    test "$(jq -er .instanceId "$state/lifecycle.json")" = "$instance"
    test ! -e "/var/lib/fased-local/$instance/controller/supervisor/product-transaction.json"
  }
  predecessor_gateway_version="$predecessor_version"
  printf '%s\n' "$version" >"$selected_target"

  run_target_installer() {
    runuser -u testop -- env "${managed_operator_env[@]}" \
      npm_config_registry="http://127.0.0.1:$rpc_port" \
      FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
      /bin/bash "$candidate_installer" \
      --release "v$version" \
      --update-channel beta \
      --local \
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
      --skip-health
  }

  acceptance_start
  managed_current_link="/opt/fased/local/$instance/current"
  managed_initial_target="$(readlink -f "$managed_current_link")"
  managed_gateway_unit="fased-gateway-$instance.service"
  managed_fault_root="/var/tmp/fased-fixture-managed-gateway-fault-$$"
  managed_fault_script="$managed_fault_root/reject-target.sh"
  managed_fault_marker="$managed_fault_root/injected"
  managed_fault_dropin="/etc/systemd/system/${managed_gateway_unit}.d/99-fased-fixture-target-fault.conf"
  mkdir -p "$managed_fault_root" "$(dirname "$managed_fault_dropin")"
  cat >"$managed_fault_script" <<EOF_MANAGED_FAILED_GATEWAY
#!/usr/bin/env bash
set -euo pipefail
: >'$managed_fault_marker'
exit 1
EOF_MANAGED_FAILED_GATEWAY
  chown root:root "$managed_fault_script"
  chmod 0755 "$managed_fault_script"
  cat >"$managed_fault_dropin" <<EOF_MANAGED_FAILED_GATEWAY_DROPIN
[Service]
ExecStartPre=+$managed_fault_script
EOF_MANAGED_FAILED_GATEWAY_DROPIN
  systemctl daemon-reload
  if run_target_installer \
      >/tmp/managed-update-failure.out 2>/tmp/managed-update-failure.err; then
    managed_failure_status=0
  else
    managed_failure_status=$?
  fi
  rm -f "$managed_fault_dropin"
  systemctl daemon-reload
  test -e "$managed_fault_marker" || {
    echo "failed to inject the managed target Gateway activation fault" >&2
    sed -n '1,200p' /tmp/managed-update-failure.err >&2
    exit 1
  }
  rm -rf -- "$managed_fault_root"
  test "$managed_failure_status" -ne 0
  managed_recovery_transaction=""
  if grep -F "target release failed and was rolled back" \
      /tmp/managed-update-failure.err >/dev/null; then
    wait_for_gateway_version "$predecessor_version"
    test "$(jq -er .runtime.activeVersion "$state/install.json")" = "$predecessor_version"
    verify_managed_state_manifest
  elif grep -F "lifecycle recovery is pending" /tmp/managed-update-failure.err >/dev/null; then
    managed_root_transaction="/var/lib/fased-local/$instance/controller/supervisor/product-transaction.json"
    managed_recovery_transaction="$(jq -er .transactionId "$managed_root_transaction")"
  else
    echo "managed update did not report a bounded rollback outcome" >&2
    sed -n '1,160p' /tmp/managed-update-failure.err >&2
    exit 1
  fi

  run_target_installer \
    >/tmp/managed-update-success.out 2>/tmp/managed-update-success.err
  acceptance_mark rollback-retry
  if [[ -n "$managed_recovery_transaction" ]]; then
    managed_recovery_receipt="/var/lib/fased-local/$instance/controller/supervisor/receipts/${managed_recovery_transaction}.json"
    test "$(jq -er .operation "$managed_recovery_receipt")" = "recoverRelease"
    test "$(jq -er .outcome "$managed_recovery_receipt")" = "rolled-back"
  fi
  wait_for_gateway_version "$version"
  test "$(jq -er .runtime.activeVersion "$state/install.json")" = "$version"
  test "$(jq -er .runtime.previousVersion "$state/install.json")" = "$predecessor_version"
  verify_managed_state_manifest
  verify_managed_semantic_state

  runtime="$(resolve_protected_runtime "$instance")"
  mapfile -t managed_operator_env < <(operator_env "$instance")
  verify_canonical_lifecycle_supervisor "$instance"
  acceptance_mark canonical-lifecycle
  verify_three_services "$instance"
  acceptance_mark three-services-active
  run_operator_acceptance "$instance" "$runtime" managed managed_operator_env
  systemctl restart \
    "fased-local-controller-$instance.service" \
    "fased-signerd-$instance.service" \
    "fased-gateway-$instance.service"
  verify_three_services "$instance"
  wait_for_gateway_version "$version"
  acceptance_mark restart-health
  verify_managed_state_manifest
  verify_managed_semantic_state
  acceptance_mark state-preservation
  runuser -u testop -- env "${managed_operator_env[@]}" \
    npm_config_registry="http://127.0.0.1:$rpc_port" \
    FASED_HOSTED_ARTIFACT_BASE_URL="http://127.0.0.1:$rpc_port" \
    "$state/bin/fased" update "${target_update_args[@]}" --timeout 120 \
    >/tmp/managed-update-noop.out 2>/tmp/managed-update-noop.err
  grep -F "Already current: $version" /tmp/managed-update-noop.out >/dev/null
  run_target_installer \
    >/tmp/managed-installer-noop.out 2>/tmp/managed-installer-noop.err
  grep -F "Already current: $version" /tmp/managed-installer-noop.out >/dev/null
  acceptance_mark installer-already-current /tmp/managed-installer-noop.out "Already current: $version"
  acceptance_mark updater-already-current /tmp/managed-update-noop.out "Already current: $version"
  acceptance_finish

  verify_wallet "$instance" agent >/tmp/managed-agent-after.json
  verify_wallet "$instance" vault >/tmp/managed-vault-after.json
  agent_readiness_sha="$(jq -S -c . /tmp/managed-agent-after.json | sha256sum | awk '{print $1}')"
  vault_readiness_sha="$(jq -S -c . /tmp/managed-vault-after.json | sha256sum | awk '{print $1}')"
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
  printf 'managed packaged Protected Local rollback, retry, restart, preservation, and no-op passed: %s\n' "$instance"
  exit 0
fi
