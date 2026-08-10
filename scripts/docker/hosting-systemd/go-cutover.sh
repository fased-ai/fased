#!/usr/bin/env bash
set -euo pipefail

version="${FASED_FIXTURE_VERSION:?}"
generation="${FASED_FIXTURE_GENERATION:?}"
dependency="${FASED_FIXTURE_DEPENDENCY:?}"
gateway_port="${FASED_FIXTURE_GATEWAY_PORT:-18789}"
lifecycled="/fixture-bin/fased-lifecycled-linux-amd64"

diagnostics() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
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

initialize() {
  install_tailscale_fixture
  if ! id app >/dev/null 2>&1; then
    useradd --create-home --home-dir /home/app --shell /bin/bash app
  fi
  "$lifecycled" initialize \
    --profile hosting \
    --instance hosting \
    --owner-state /home/app/.fased \
    --operator-user app \
    --generation-archive "$generation" \
    --dependency-archive "$dependency" \
    --gateway-port "$gateway_port"
}

complete_onboarding() {
  test -d /home/app/.fased
  test "$(stat -c %a /home/app/.fased)" = 2770
  runuser -u app -- env \
    HOME=/home/app \
    FASED_STATE_DIR=/home/app/.fased \
    FASED_CONFIG_PATH=/home/app/.fased/fased.json \
    FASED_HOST_PROFILE=hosting \
    FASED_HOST_ROOT_PREPARED=1 \
    FASED_INSTALLER_ONBOARD=1 \
    FASED_INSTALL_LIFECYCLE_COMMITTED=1 \
    FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external \
    FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock \
    FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock \
    /home/app/.fased/bin/fased onboard --install-daemon \
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
  test "$(stat -c %a /home/app/.fased/fased.json)" = 660
  test "$(stat -c %G /home/app/.fased/fased.json)" = fased-config
  request_id="$(cat /proc/sys/kernel/random/uuid)"
  "$lifecycled" request \
    --socket /run/fased-host-updater/request.sock \
    --operation COMPLETE_ONBOARDING \
    --request-id "$request_id"
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

case "${1:-}" in
  install)
    initialize
    systemctl is-active --quiet fased-host-updater.service
    systemctl is-active --quiet fased-host-controller.service
    systemctl is-active --quiet fased-signerd.service
    ! systemctl is-active --quiet fased-gateway.service
    test ! -e /home/app/.fased/fased.json
    complete_onboarding
    assert_healthy
    output="$(initialize)"
    grep -Fq 'ALREADY_CURRENT' <<<"$output"
    ;;
  verify-reboot)
    install_tailscale_fixture
    assert_healthy
    output="$(initialize)"
    grep -Fq 'ALREADY_CURRENT' <<<"$output"
    ;;
  *)
    echo "usage: go-cutover.sh install|verify-reboot" >&2
    exit 1
    ;;
esac
