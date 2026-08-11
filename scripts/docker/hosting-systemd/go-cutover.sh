#!/usr/bin/env bash
set -euo pipefail

version="${FASED_FIXTURE_VERSION:?}"
gateway_port="${FASED_FIXTURE_GATEWAY_PORT:-18789}"
candidate_installer="/artifacts/install.sh"

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
    systemctl status fased-host-updater.service fased-host-controller.service fased-signerd.service fased-gateway.service --no-pager >&2 || true
    journalctl -u fased-host-updater.service -u fased-host-controller.service -u fased-signerd.service -u fased-gateway.service -n 160 --no-pager >&2 || true
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

  cat >/usr/local/bin/gh <<EOF_FIXTURE_GH
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "attestation" && "\${2:-}" == "verify" ]]; then
  if [[ "\${3:-}" == "--help" ]]; then
    exit 0
  fi
  args=("\$@")
  for ((index = 0; index < \${#args[@]}; index++)); do
    if [[ "\${args[\$index]}" == "--source-ref" &&
      "\${args[\$((index + 1))]:-}" == "refs/tags/v${version}" ]]; then
      exit 0
    fi
  done
fi
exit 1
EOF_FIXTURE_GH
  chmod 0755 /usr/local/bin/gh
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
  grep -Fq '/payload/bin/fased-lifecycled target' \
    /etc/systemd/system/fased-host-controller.service
  test "$(cat /var/lib/fased-host-updater/signer-version)" = "$version"
  jq -e --arg version "$version" '.schemaVersion == 1 and .version == $version' \
    /var/lib/fased-host-updater/controller-version.json >/dev/null
  for unit in fased-host-updater.service fased-host-controller.service fased-signerd.service fased-gateway.service; do
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

assert_already_current_receipts() {
  receipt_file="$1"
  sed -n '/^{/p' "$receipt_file" | jq -se --arg version "$version" '
    length == 2 and
    .[0].version == $version and
    .[0].outcome == "ALREADY_CURRENT" and
    .[1].outcome == "ALREADY_CURRENT"
  ' >/dev/null
}

case "${1:-}" in
  install)
    install_tailscale_fixture
    ! command -v node >/dev/null 2>&1
    install_release_transport_fixture
    run_public_installer >/tmp/fased-hosting-install.out 2>/tmp/fased-hosting-install.err
    command -v node >/dev/null 2>&1
    node -e 'require("node:sqlite")'
    assert_healthy
    run_public_installer >/tmp/fased-hosting-noop.out 2>/tmp/fased-hosting-noop.err
    assert_already_current_receipts /tmp/fased-hosting-noop.out
    ;;
  verify-reboot)
    install_tailscale_fixture
    assert_healthy
    run_public_installer >/tmp/fased-hosting-reboot-noop.out 2>/tmp/fased-hosting-reboot-noop.err
    assert_already_current_receipts /tmp/fased-hosting-reboot-noop.out
    ;;
  *)
    echo "usage: go-cutover.sh install|verify-reboot" >&2
    exit 1
    ;;
esac
