#!/usr/bin/env bash
set -euo pipefail

# Artifact-only Hosting acceptance for the stable lifecycle appliance.

version="${FASED_FIXTURE_VERSION:?}"
commit="${FASED_FIXTURE_COMMIT:?}"
gateway_port="${FASED_FIXTURE_GATEWAY_PORT:-18789}"
candidate_installer="/artifacts/install.sh"
acceptance_contract=/artifacts/fased-lifecycle-acceptance-v2.json
acceptance_descriptor=/artifacts/fased-hosting-candidate.json
acceptance_evidence=/tmp/fased-hosting-acceptance.evidence.jsonl
acceptance_receipt=/var/lib/fased-lifecycled/lifecycle-acceptance-fresh-install.json

diagnostics() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    for receipt in /tmp/fased-hosting-{install,noop,reboot-noop}.{out,err}; do
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
  [[ "\$asset" =~ ^[A-Za-z0-9._+-]+$ && -f "/artifacts/\$asset" && ! -L "/artifacts/\$asset" ]] || exit 22
  install -m 0600 "/artifacts/\$asset" "\$output"
  exit 0
fi
exec /usr/local/libexec/fased-fixture-curl-real "\$@"
EOF_FIXTURE_CURL
  chmod 0755 /usr/bin/curl

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
    '{id:$id,status:"PASS",evidenceDigest:$evidenceDigest,summary:$summary}' \
    >>"$acceptance_evidence"
}

acceptance_start() {
  node /fixture-tools/lifecycle-acceptance-contract.mjs validate \
    --contract "$acceptance_contract" >/dev/null
  : >"$acceptance_evidence"
  acceptance_mark artifact-identity "$acceptance_descriptor" "candidate descriptor verified"
  acceptance_mark public-installer-acquisition "$candidate_installer" \
    "stamped public installer acquired"
}

acceptance_finish() {
  local evidence_json=/tmp/fased-hosting-acceptance.evidence.json
  local descriptor_digest="sha256:$(sha256sum "$acceptance_descriptor" | awk '{print $1}')"
  jq -s . "$acceptance_evidence" >"$evidence_json"
  node /fixture-tools/lifecycle-acceptance-contract.mjs issue-receipt \
    --contract "$acceptance_contract" \
    --profile hosting \
    --scenario fresh-install \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "" \
    --evidence-file "$evidence_json" \
    --output "$acceptance_receipt"
  node /fixture-tools/lifecycle-receipt-verifier.mjs \
    --contract "$acceptance_contract" \
    --receipt "$acceptance_receipt" \
    --profile hosting \
    --scenario fresh-install \
    --version "$version" \
    --commit "$commit" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "" >/dev/null
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
  ! test -e /etc/systemd/system/fased-host-controller.service
  test "$(cat /var/lib/fased-host-updater/signer-version)" = "$version"
  jq -e --arg version "$version" '.schemaVersion == 1 and .version == $version' \
    /var/lib/fased-host-updater/controller-version.json >/dev/null
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

run_operator_acceptance() {
  local cli=/home/app/.fased/bin/fased
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

  runuser -u app -- env HOME=/home/app "$cli" mining status --json \
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
  runuser -u app -- env HOME=/home/app /home/app/.fased/bin/fased update \
    --channel beta --timeout 120
}

case "${1:-}" in
  install)
    install_tailscale_fixture
    ! command -v node >/dev/null 2>&1
    install_release_transport_fixture
    run_public_installer >/tmp/fased-hosting-install.out 2>/tmp/fased-hosting-install.err
    command -v node >/dev/null 2>&1
    node -e 'require("node:sqlite")'
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
  verify-reboot)
    install_tailscale_fixture
    assert_healthy
    run_public_installer >/tmp/fased-hosting-reboot-noop.out 2>/tmp/fased-hosting-reboot-noop.err
    grep -F "Already current: $version" /tmp/fased-hosting-reboot-noop.out >/dev/null
    ;;
  *)
    echo "usage: go-cutover.sh install|verify-reboot" >&2
    exit 1
    ;;
esac
