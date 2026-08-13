#!/usr/bin/env bash
set -euo pipefail

# Artifact-only Hosting acceptance for the stable lifecycle appliance.

version="${FASED_FIXTURE_VERSION:?}"
commit="${FASED_FIXTURE_COMMIT:?}"
predecessor_version="${FASED_FIXTURE_PREDECESSOR_VERSION:-}"
predecessor_class="${FASED_FIXTURE_PREDECESSOR_CLASS:-public-stable}"
target_channel=stable
if [[ "$version" == *-* ]]; then
  target_channel=beta
fi
phase="${1:-install}"
scenario="$([[ "$phase" == "managed-update" ]] && printf managed-update || printf fresh-install)"
gateway_port="${FASED_FIXTURE_GATEWAY_PORT:-18789}"
candidate_installer="/artifacts/install.sh"
acceptance_contract=/artifacts/fased-lifecycle-acceptance-v2.json
acceptance_descriptor=/artifacts/fased-hosting-candidate.json
acceptance_evidence=/tmp/fased-hosting-acceptance.evidence.jsonl
acceptance_receipt="/var/lib/fased-lifecycled/lifecycle-acceptance-${scenario}.json"
acceptance_evidence_class=PASS
acceptance_acquisition_evidence_class=SUPPORTING
acceptance_release_base_url="https://github.com/fased-ai/fased/releases/download/v${version}"
predecessor_capsule_descriptor=/predecessor-capsule/fased-predecessor-capsule.json
predecessor_capsule_attestation=/predecessor-capsule/fased-predecessor-capsule.json.attestation.json
predecessor_capsule_branch_proof=/predecessor-capsule/fased-predecessor-branch-proof.json
predecessor_capsule_authorization=/run/fased-predecessor-capsule-fixture-authorized
fixture_transport_root=/var/lib/fased-hosting-fixture
fixture_tls="$fixture_transport_root/tls"
export NO_PROXY="github.com,registry.npmjs.org,127.0.0.1,localhost"
export no_proxy="$NO_PROXY"

diagnostics() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    for receipt in /tmp/fased-hosting-{install,noop,update-noop,reboot-noop}.{out,err}; do
      if [[ -f "$receipt" ]]; then
        printf '\n--- %s ---\n' "$receipt" >&2
        sed -n '1,120p' "$receipt" >&2
      fi
    done
    systemctl --failed --no-pager >&2 || true
    systemctl status fased-host-updater.service fased-signerd.service fased-gateway.service --no-pager >&2 || true
    journalctl -u fased-host-updater.service -u fased-signerd.service -u fased-gateway.service -n 160 --no-pager >&2 || true
  fi
  exit "$status"
}
trap diagnostics EXIT

install_tailscale_fixture() {
  cat >/usr/bin/tailscale <<'EOF_TAILSCALE'
#!/usr/bin/env bash
if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then
  printf '%s\n' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.10"]}}'
  exit 0
fi
exit 1
EOF_TAILSCALE
  chown root:root /usr/bin/tailscale
  chmod 0755 /usr/bin/tailscale
}

install_release_transport_fixture() {
  install -d -m 0755 -o root -g root /usr/local/libexec
  install -m 0755 -o root -g root /usr/bin/curl \
    /usr/local/libexec/fased-fixture-curl-real
  install -d -m 0755 -o root -g root "$fixture_tls"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
    -subj "/CN=Fased Hosting lifecycle fixture CA" \
    -keyout "$fixture_tls/ca.key" \
    -out "$fixture_tls/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -subj "/CN=github.com" \
    -keyout "$fixture_tls/github.key" \
    -out "$fixture_tls/github.csr" >/dev/null 2>&1
  cat >"$fixture_tls/github.ext" <<'EOF_FIXTURE_TLS_EXT'
subjectAltName=DNS:github.com,DNS:registry.npmjs.org
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
      /usr/local/share/ca-certificates/fased-hosting-fixture.crt
    update-ca-certificates >/dev/null
  else
    install -m 0644 "$fixture_tls/ca.crt" \
      /etc/pki/ca-trust/source/anchors/fased-hosting-fixture.crt
    update-ca-trust extract
  fi
  grep -Fqx "127.0.0.1 github.com" /etc/hosts ||
    printf '127.0.0.1 github.com\n' >>/etc/hosts
  grep -Fqx "127.0.0.1 registry.npmjs.org" /etc/hosts ||
    printf '127.0.0.1 registry.npmjs.org\n' >>/etc/hosts
  cat >/usr/local/libexec/fased-hosting-release-server.mjs <<'EOF_RELEASE_SERVER'
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const version = process.env.FASED_FIXTURE_VERSION;
const assets = "/artifacts";
const prefix = `/fased-ai/fased/releases/download/v${version}/`;

function serve(response, name) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
    response.writeHead(400).end();
    return;
  }
  const selected = path.join(assets, name);
  try {
    const stat = fs.lstatSync(selected);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe asset");
    response.writeHead(200, { "content-length": stat.size });
    fs.createReadStream(selected).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}

function selectFixtureTrustAsset(asset) {
  const branchAsset = {
    "fased-lifecycle-root-v1.json": "fased-branch-root.json",
    "fased-release-index-v1.json": "fased-branch-release-index.json",
    "fased-release-index-v1.json.attestation.json": "fased-branch-delegation.json",
  }[asset];
  return branchAsset && fs.existsSync(`/artifacts/${branchAsset}`) ? branchAsset : asset;
}

https.createServer(
  {
    key: fs.readFileSync("/var/lib/fased-hosting-fixture/tls/github.key"),
    cert: fs.readFileSync("/var/lib/fased-hosting-fixture/tls/github.crt"),
  },
  (request, response) => {
    if (request.method !== "GET" || !request.url) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/@fased%2ffased/beta" || request.url === "/@fased%2ffased/latest") {
      const body = JSON.stringify({ version });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (request.url.startsWith(prefix)) {
      const requested = decodeURIComponent(request.url.slice(prefix.length));
      const selected = selectFixtureTrustAsset(requested);
      serve(response, selected);
      return;
    }
    response.writeHead(404).end();
  },
).listen(443, "127.0.0.1");
EOF_RELEASE_SERVER
  start_release_transport_server
  cat >/usr/bin/curl <<EOF_FIXTURE_CURL
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
args=("\$@")
for ((index = 0; index < \${#args[@]}; index++)); do
  case "\${args[\$index]}" in
    -o)
      output="\${args[\$((index + 1))]:-}"
      index=\$((index + 1))
      ;;
    http://*|https://*) url="\${args[\$index]}" ;;
  esac
done
prefix="https://github.com/fased-ai/fased/releases/download/v${version}/"
if [[ "\$url" == "\$prefix"* && -n "\$output" ]]; then
  asset="\${url#\$prefix}"
  branch_asset=""
  case "\$asset" in
    fased-lifecycle-root-v1.json) branch_asset=fased-branch-root.json ;;
    fased-release-index-v1.json) branch_asset=fased-branch-release-index.json ;;
    fased-release-index-v1.json.attestation.json) branch_asset=fased-branch-delegation.json ;;
  esac
  if [[ -n "\$branch_asset" && -f "/artifacts/\$branch_asset" ]]; then
    asset="\$branch_asset"
  fi
  [[ "\$asset" =~ ^[A-Za-z0-9._+-]+$ && -f "/artifacts/\$asset" && ! -L "/artifacts/\$asset" ]] || exit 22
  install -m 0600 "/artifacts/\$asset" "\$output"
  exit 0
fi
exec /usr/local/libexec/fased-fixture-curl-real "\$@"
EOF_FIXTURE_CURL
  chmod 0755 /usr/bin/curl

}

start_release_transport_server() {
  grep -Fqx "127.0.0.1 github.com" /etc/hosts ||
    printf '127.0.0.1 github.com\n' >>/etc/hosts
  grep -Fqx "127.0.0.1 registry.npmjs.org" /etc/hosts ||
    printf '127.0.0.1 registry.npmjs.org\n' >>/etc/hosts
  FASED_FIXTURE_VERSION="$version" \
    /fixture-node /usr/local/libexec/fased-hosting-release-server.mjs \
    >/tmp/fased-hosting-release-server.log 2>&1 &
  fixture_release_server_pid=$!
  for _ in {1..40}; do
    kill -0 "$fixture_release_server_pid" 2>/dev/null || {
      cat /tmp/fased-hosting-release-server.log >&2
      return 1
    }
    if /usr/local/libexec/fased-fixture-curl-real -fsS \
      "https://github.com/fased-ai/fased/releases/download/v${version}/fased-lifecycle-root-v1.json" \
      >/dev/null; then
      break
    fi
    sleep 0.1
  done
  /usr/local/libexec/fased-fixture-curl-real -fsS \
    "https://github.com/fased-ai/fased/releases/download/v${version}/fased-lifecycle-root-v1.json" \
    >/dev/null
}

acceptance_mark() {
  local predicate="$1"
  local evidence_file="$2"
  local summary="${3:-verified}"
  test -s "$evidence_file"
  jq -cn \
    --arg id "$predicate" \
    --arg evidenceDigest "sha256:$(sha256sum "$evidence_file" | awk '{print $1}')" \
    --arg summary "$summary" \
    --arg status "$([[ "$predicate" == "public-installer-acquisition" ]] && \
      printf '%s' "$acceptance_acquisition_evidence_class" || \
      printf '%s' "$acceptance_evidence_class")" \
    '{id:$id,status:$status,evidenceDigest:$evidenceDigest,summary:$summary}' \
    >>"$acceptance_evidence"
}

acceptance_start() {
  /fixture-node /fixture-tools/lifecycle-acceptance-contract.mjs validate \
    --contract "$acceptance_contract" >/dev/null
  : >"$acceptance_evidence"
  acceptance_mark artifact-identity "$acceptance_descriptor" "candidate descriptor verified"
  acceptance_mark public-installer-acquisition "$candidate_installer" \
    "stamped public installer acquired"
  if [[ "$scenario" == "managed-update" ]]; then
    predecessor_capsule_evidence="$predecessor_capsule_attestation"
    [[ -s "$predecessor_capsule_evidence" ]] || predecessor_capsule_evidence="$predecessor_capsule_branch_proof"
    acceptance_mark predecessor-capsule-attestation "$predecessor_capsule_evidence" \
      "predecessor capsule provenance verified"
  fi
}

acceptance_finish() {
  local evidence_json=/tmp/fased-hosting-acceptance.evidence.json
  local descriptor_digest="sha256:$(sha256sum "$acceptance_descriptor" | awk '{print $1}')"
  local capsule_digest=""
  local installation_class_digest=""
  if [[ "$scenario" == "managed-update" ]]; then
    capsule_digest="sha256:$(sha256sum "$predecessor_capsule_descriptor" | awk '{print $1}')"
    installation_class_digest="$(jq -er .installationClassDigest "$predecessor_capsule_descriptor")"
  fi
  jq -s . "$acceptance_evidence" >"$evidence_json"
  /fixture-node /fixture-tools/lifecycle-acceptance-contract.mjs issue-receipt \
    --contract "$acceptance_contract" \
    --profile hosting \
    --scenario "$scenario" \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "$capsule_digest" \
    --predecessor-installation-class "$([[ "$scenario" == "managed-update" ]] && printf '%s' "$predecessor_class" || true)" \
    --predecessor-installation-class-digest "$installation_class_digest" \
    --evidence-class "$acceptance_evidence_class" \
    --acquisition-evidence-class "$acceptance_acquisition_evidence_class" \
    --acquisition-mode substituted-fixture \
    --release-base-url "$acceptance_release_base_url" \
    --metadata-base-url "$acceptance_release_base_url" \
    --transport-substituted true \
    --trust-inventory-digest "$descriptor_digest" \
    --evidence-file "$evidence_json" \
    --output "$acceptance_receipt"
  /fixture-node /fixture-tools/lifecycle-receipt-verifier.mjs \
    --contract "$acceptance_contract" \
    --receipt "$acceptance_receipt" \
    --profile hosting \
    --scenario "$scenario" \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "$capsule_digest" \
    --predecessor-installation-class "$([[ "$scenario" == "managed-update" ]] && printf '%s' "$predecessor_class" || true)" \
    --predecessor-installation-class-digest "$installation_class_digest" \
    --evidence-class "$acceptance_evidence_class" \
    --acquisition-evidence-class "$acceptance_acquisition_evidence_class" >/dev/null
}

run_public_installer() {
  FASED_INSTALL_USER=app \
    bash "$candidate_installer" \
      --hosting \
      --release "v$version" \
      --update-channel beta \
      -- \
      --non-interactive \
      --accept-risk \
      --auth-choice skip \
      --workspace /home/app/.fased/workspace \
      --gateway-auth token \
      --gateway-token fased-hosting-fixture-token \
      --gateway-port "$gateway_port" \
      --gateway-bind loopback \
      --skip-skills \
      --skip-health
}

assert_healthy() {
  test "$(jq -er .profile /var/lib/fased-lifecycled/installation-manifest.json)" = hosting
  test "$(jq -er .activeGeneration.version /var/lib/fased-lifecycled/installation-manifest.json)" = "$version"
  grep -Fq '/opt/fased/lifecycle/supervisor-v1/fased-lifecycled supervisor' \
    /etc/systemd/system/fased-host-updater.service
  grep -Fq '/payload/bin/fased-gateway-launch' \
    /etc/systemd/system/fased-gateway.service
  test -x /opt/fased/current/payload/bin/node
  /opt/fased/current/payload/bin/node -e 'require("node:sqlite")'
  grep -Fq 'exec "$PAYLOAD/bin/node"' \
    /opt/fased/current/payload/bin/fased-gateway-launch
  ! test -e /etc/systemd/system/fased-host-controller.service
  test "$(cat /var/lib/fased-host-updater/signer-version)" = "$version"
  for unit in fased-host-updater.service fased-signerd.service fased-gateway.service; do
    systemctl is-enabled --quiet "$unit"
    systemctl is-active --quiet "$unit"
  done
  response=""
  for _ in {1..60}; do
    response="$(curl -fsS --max-time 2 "http://127.0.0.1:${gateway_port}/healthz" 2>/dev/null || true)"
    if jq -e --arg version "$version" '.version == $version' <<<"$response" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  jq -e --arg version "$version" '.version == $version' <<<"$response" >/dev/null
  ! ss -H -ltn | awk -v port=":${gateway_port}" '$4 ~ port "$" && ($4 ~ /^0\.0\.0\.0:/ || $4 ~ /^\[::\]:/ || $4 ~ /^\*:/) { found=1 } END { exit found ? 0 : 1 }'
}

configure_fixture_sat_runtime() {
  local dropin_dir=/etc/systemd/system/fased-gateway.service.d
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
  systemctl restart fased-gateway.service
  assert_healthy
}

run_operator_acceptance() {
  local cli=/home/app/.fased/bin/fased
  configure_fixture_sat_runtime
  runuser -u app -- env HOME=/home/app "$cli" wallet status --json \
    >/tmp/fased-hosting-wallet-status.json
  jq -e '.ok == true' /tmp/fased-hosting-wallet-status.json >/dev/null
  acceptance_mark wallet-status /tmp/fased-hosting-wallet-status.json "wallet status verified"

  runuser -u app -- env HOME=/home/app "$cli" wallet signer doctor --json \
    >/tmp/fased-hosting-signer-doctor.json
  jq -e '.ok == true and all(.checks[]; .ok == true)' \
    /tmp/fased-hosting-signer-doctor.json >/dev/null
  acceptance_mark wallet-signer-doctor /tmp/fased-hosting-signer-doctor.json \
    "wallet signer doctor verified"

  runuser -u app -- env \
    HOME=/home/app \
    FASED_SAT_PROGRAM_ID=11111111111111111111111111111111 \
    FASED_SAT_BOND_PROGRAM_ID=ComputeBudget111111111111111111111111111111 \
    FASED_SAT_MINT_ADDRESS=So11111111111111111111111111111111111111112 \
    FASED_SAT_MINT_PROGRAM_ID=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
    "$cli" mining status --json \
    >/tmp/fased-hosting-mining-status.json
  jq -e 'type == "object"' /tmp/fased-hosting-mining-status.json >/dev/null
  acceptance_mark mining-status /tmp/fased-hosting-mining-status.json "mining status verified"

  runuser -u app -- env HOME=/home/app "$cli" federation status --json \
    >/tmp/fased-hosting-network-status.json
  jq -e 'type == "object"' /tmp/fased-hosting-network-status.json >/dev/null
  acceptance_mark network-status /tmp/fased-hosting-network-status.json "network status verified"

  runuser -u app -- env HOME=/home/app "$cli" plugins doctor \
    >/tmp/fased-hosting-plugin-doctor.out
  grep -Fq "No plugin issues detected." /tmp/fased-hosting-plugin-doctor.out
  acceptance_mark plugin-doctor /tmp/fased-hosting-plugin-doctor.out "plugin doctor verified"
}

run_public_updater() {
  local sudoers_policy=/etc/sudoers.d/fased-hosting-fixture-update
  test -x /opt/fased/lifecycle/bootstrap-v1/fased-bootstrap
  umask 077
  printf \
    'app ALL=(root) NOPASSWD: /opt/fased/lifecycle/bootstrap-v1/fased-bootstrap update --profile hosting --channel %s --version %s\n' \
    "$target_channel" "$version" >"$sudoers_policy"
  chown root:root "$sudoers_policy"
  chmod 0440 "$sudoers_policy"
  visudo -cf "$sudoers_policy" >/dev/null
  runuser -u app -- env HOME=/home/app /home/app/.fased/bin/fased update \
    --channel "$target_channel" --tag "$version" --timeout 120
}

wait_for_gateway_version() {
  local expected="$1"
  local response=""
  for _ in {1..80}; do
    response="$(curl -fsS --max-time 2 "http://127.0.0.1:${gateway_port}/healthz" 2>/dev/null || true)"
    if jq -e --arg version "$expected" '.version == $version' <<<"$response" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

restore_public_predecessor() {
  install -m 0755 /fixture-node /usr/local/bin/node
  useradd --uid 2000 --user-group --create-home --shell /bin/bash app
  predecessor_archive="$(jq -er .archive.name "$predecessor_capsule_descriptor")"
  printf 'fased-predecessor-capsule-fixture-v1\n' >"$predecessor_capsule_authorization"
  chown root:root "$predecessor_capsule_authorization"
  chmod 0600 "$predecessor_capsule_authorization"
  /usr/local/bin/node /fixture-tools/restore-predecessor-capsule.mjs restore \
    --descriptor "$predecessor_capsule_descriptor" \
    --archive "/predecessor-capsule/$predecessor_archive" \
    --root / \
    --authorization-marker "$predecessor_capsule_authorization" \
    --operator-uid 2000 \
    --operator-gid 2000 \
    --profile hosting \
    --installation-class "$predecessor_class" \
    >/tmp/fased-hosting-predecessor-restore.out
  rm -f "$predecessor_capsule_authorization"
  test "$(jq -er .installationClass.kind "$predecessor_capsule_descriptor")" = \
    "$predecessor_class"
  systemctl daemon-reload
  while IFS= read -r unit; do systemctl enable --now "$unit"; done \
    < <(jq -er '.services[]' "$predecessor_capsule_descriptor")
  wait_for_gateway_version "$predecessor_version"
  # Seed the compatibility fixture with the predecessor quiesced. Otherwise
  # its asynchronous config normalization can race this external write and
  # make the later preservation comparison measure fixture timing rather than
  # lifecycle state.
  systemctl stop fased-gateway.service
  install -d -m 0700 -o app -g app \
    /home/app/.fased/extensions /home/app/.fased/extensions/stable-bridge \
    /home/app/.fased/plugin-data /home/app/.fased/plugin-data/stable-bridge
  printf '%s\n' '{"id":"stable-bridge","configSchema":{"type":"object","additionalProperties":false}}' \
    >/home/app/.fased/extensions/stable-bridge/fased.plugin.json
  printf '%s\n' '{"name":"stable-bridge","type":"module","fased":{"extensions":["./index.js"]}}' \
    >/home/app/.fased/extensions/stable-bridge/package.json
  printf '%s\n' 'export default { id: "stable-bridge", register() {} };' \
    >/home/app/.fased/extensions/stable-bridge/index.js
  printf '%s\n' '{"schemaVersion":1,"historyRevision":7}' \
    >/home/app/.fased/plugin-data/stable-bridge/state.json
  chown -R app:app /home/app/.fased/extensions /home/app/.fased/plugin-data
  chmod 0700 /home/app/.fased/extensions /home/app/.fased/extensions/stable-bridge \
    /home/app/.fased/plugin-data /home/app/.fased/plugin-data/stable-bridge
  chmod 0600 /home/app/.fased/extensions/stable-bridge/* \
    /home/app/.fased/plugin-data/stable-bridge/state.json
  jq \
    '.plugins = (.plugins // {}) |
     .plugins.allow = (((.plugins.allow // []) + ["stable-bridge"]) | unique) |
     .plugins.entries = (.plugins.entries // {}) |
     .plugins.entries["stable-bridge"] = ((.plugins.entries["stable-bridge"] // {}) + {enabled: true})' \
    /home/app/.fased/fased.json >/tmp/fased-hosting-stable-bridge-config.json
  install -m 0600 -o app -g app /tmp/fased-hosting-stable-bridge-config.json /home/app/.fased/fased.json
  rm -f /tmp/fased-hosting-stable-bridge-config.json
  systemctl start fased-gateway.service
  wait_for_gateway_version "$predecessor_version"
  previous_config_digest=""
  stable_config_samples=0
  for _ in {1..40}; do
    config_digest="$(sha256sum /home/app/.fased/fased.json | awk '{print $1}')"
    if [[ "$config_digest" == "$previous_config_digest" ]]; then
      stable_config_samples=$((stable_config_samples + 1))
      if [[ "$stable_config_samples" -ge 3 ]]; then
        break
      fi
    else
      previous_config_digest="$config_digest"
      stable_config_samples=0
    fi
    sleep 0.25
  done
  [[ "$stable_config_samples" -ge 3 ]] || {
    echo "The public predecessor configuration did not settle after plugin seeding." >&2
    exit 1
  }
}

case "$phase" in
  install)
    install_tailscale_fixture
    ! command -v node >/dev/null 2>&1
    install_release_transport_fixture
    run_public_installer >/tmp/fased-hosting-install.out 2>/tmp/fased-hosting-install.err
    ! command -v node >/dev/null 2>&1
    acceptance_start
    assert_healthy
    acceptance_mark canonical-lifecycle /var/lib/fased-lifecycled/installation-manifest.json \
      "canonical Hosting lifecycle verified"
    systemctl status fased-host-updater.service fased-signerd.service \
      fased-gateway.service --no-pager >/tmp/fased-hosting-three-services.out
    acceptance_mark three-services-active /tmp/fased-hosting-three-services.out \
      "three Hosting services active"
    run_operator_acceptance
    sha256sum /var/lib/fased-lifecycled/installation-manifest.json \
      /home/app/.fased/fased.json >/tmp/fased-hosting-state-before.sha256
    systemctl restart fased-host-updater.service fased-signerd.service fased-gateway.service
    assert_healthy
    acceptance_mark restart-health /var/lib/fased-lifecycled/installation-manifest.json \
      "restart health verified"
    sha256sum --check /tmp/fased-hosting-state-before.sha256 \
      >/tmp/fased-hosting-state-preservation.out
    acceptance_mark state-preservation /tmp/fased-hosting-state-preservation.out \
      "state preserved"
    run_public_installer >/tmp/fased-hosting-noop.out 2>/tmp/fased-hosting-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-noop.out >/dev/null
    run_public_updater >/tmp/fased-hosting-update-noop.out 2>/tmp/fased-hosting-update-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-update-noop.out >/dev/null
    acceptance_mark installer-already-current /tmp/fased-hosting-noop.out \
      "Already current: $version"
    acceptance_mark updater-already-current /tmp/fased-hosting-update-noop.out \
      "Already current: $version"
    acceptance_finish
    ;;
  managed-update)
    [[ "$predecessor_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]
    test -f "$predecessor_capsule_descriptor"
    test -s "$predecessor_capsule_attestation" || test -s "$predecessor_capsule_branch_proof"
    restore_public_predecessor
    install_tailscale_fixture
    install_release_transport_fixture
    test "$(jq -er .profile /home/app/.fased/install.json)" = hosting
    test "$(jq -er .runtime.activeVersion /home/app/.fased/install.json)" = "$predecessor_version"
    sha256sum \
      /home/app/.fased/identity/device.json \
      /home/app/.fased/wallet/provider-registry.v1.json \
      /home/app/.fased/extensions/stable-bridge/fased.plugin.json \
      /home/app/.fased/extensions/stable-bridge/package.json \
      /home/app/.fased/extensions/stable-bridge/index.js \
      /home/app/.fased/plugin-data/stable-bridge/state.json \
      >/tmp/fased-hosting-predecessor-state.sha256
    cp /home/app/.fased/fased.json /tmp/fased-hosting-predecessor-config.json
    acceptance_start

    fault_dir=/etc/systemd/system/fased-gateway.service.d
    fault_marker=/run/fased-hosting-target-fault
    install -d -m 0755 -o root -g root "$fault_dir"
    cat >/usr/local/bin/fased-hosting-target-fault <<'EOF_TARGET_FAULT'
#!/usr/bin/env bash
set -euo pipefail
marker=/run/fased-hosting-target-fault
if [[ ! -e "$marker" ]] && grep -Fq '/opt/fased/generations/' /etc/systemd/system/fased-gateway.service; then
  : >"$marker"
  exit 1
fi
EOF_TARGET_FAULT
    chmod 0755 /usr/local/bin/fased-hosting-target-fault
    cat >"$fault_dir/99-fased-fixture-target-fault.conf" <<'EOF_TARGET_DROPIN'
[Service]
ExecStartPre=+/usr/local/bin/fased-hosting-target-fault
EOF_TARGET_DROPIN
    systemctl daemon-reload
    if run_public_installer >/tmp/fased-hosting-update-failure.out 2>/tmp/fased-hosting-update-failure.err; then
      echo "Hosting target fault did not stop the first update" >&2
      exit 1
    fi
    test -e "$fault_marker"
    rm -f "$fault_dir/99-fased-fixture-target-fault.conf" /usr/local/bin/fased-hosting-target-fault
    rmdir "$fault_dir" 2>/dev/null || true
    systemctl daemon-reload
    wait_for_gateway_version "$predecessor_version"
    test "$(jq -er .gateway.mode /home/app/.fased/fased.json)" = remote
    sha256sum --check /tmp/fased-hosting-predecessor-state.sha256

    run_public_installer >/tmp/fased-hosting-update.out 2>/tmp/fased-hosting-update.err
    acceptance_mark rollback-retry /tmp/fased-hosting-update.out "rollback and identical retry verified"
    assert_healthy
    acceptance_mark canonical-lifecycle /var/lib/fased-lifecycled/installation-manifest.json \
      "canonical Hosting lifecycle verified"
    systemctl status fased-host-updater.service fased-signerd.service fased-gateway.service \
      --no-pager >/tmp/fased-hosting-three-services.out
    acceptance_mark three-services-active /tmp/fased-hosting-three-services.out \
      "three Hosting services active"
    run_operator_acceptance
    stable_bridge_plugin_digest="$(jq -er '.entries[] | select(.id == "stable-bridge" and .origin == "store" and .required == true) | .digest' /home/app/.fased/plugin.lock.json)"
    stable_bridge_plugin_object="/opt/fased/plugin-code/${stable_bridge_plugin_digest#sha256:}"
    runuser -u fased-gateway -- test -r "$stable_bridge_plugin_object/index.js"
    runuser -u fased-gateway -- test -r /home/app/.fased/plugin-data/stable-bridge/state.json
    jq -e --arg digest "$stable_bridge_plugin_digest" \
      '.entries[] | select(.id == "stable-bridge" and .origin == "store" and .digest == $digest and .status == "loaded")' \
      /home/app/.fased/cache/plugin-readiness.json >/dev/null
    test "$(jq -er .gateway.mode /home/app/.fased/fased.json)" = local
    {
      sha256sum --check /tmp/fased-hosting-predecessor-state.sha256
      /fixture-node /fixture-tools/lifecycle-configuration-preservation.mjs \
        --before /tmp/fased-hosting-predecessor-config.json \
        --after /home/app/.fased/fased.json \
        --target-version "$version" \
        --profile hosting
    } >/tmp/fased-hosting-update-state-preservation.out
    systemctl restart fased-host-updater.service fased-signerd.service fased-gateway.service
    assert_healthy
    acceptance_mark restart-health /var/lib/fased-lifecycled/installation-manifest.json \
      "restart health verified"
    acceptance_mark state-preservation /tmp/fased-hosting-update-state-preservation.out \
      "predecessor state preserved"
    run_public_installer >/tmp/fased-hosting-update-installer-noop.out 2>/tmp/fased-hosting-update-installer-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-update-installer-noop.out >/dev/null
    run_public_updater >/tmp/fased-hosting-update-noop.out 2>/tmp/fased-hosting-update-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-update-noop.out >/dev/null
    acceptance_mark installer-already-current /tmp/fased-hosting-update-installer-noop.out \
      "Already current: $version"
    acceptance_mark updater-already-current /tmp/fased-hosting-update-noop.out \
      "Already current: $version"
    acceptance_finish
    ;;
  verify-reboot)
    install_tailscale_fixture
    start_release_transport_server
    assert_healthy
    run_public_installer >/tmp/fased-hosting-reboot-noop.out 2>/tmp/fased-hosting-reboot-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-reboot-noop.out >/dev/null
    ;;
  *)
    echo "usage: lifecycle-acceptance.sh install|managed-update|verify-reboot" >&2
    exit 1
    ;;
esac
