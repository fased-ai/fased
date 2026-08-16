#!/usr/bin/env bash
set -euo pipefail

readonly HEADSCALE_IMAGE="ghcr.io/juanfont/headscale@sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72"
readonly HEADSCALE_CONFIG_URL="https://raw.githubusercontent.com/juanfont/headscale/v0.29.3/config-example.yaml"
readonly HEADSCALE_CONFIG_SHA256="51f6568cbb51628ef2c8b6999f3fe7ed3f14147b684908b17ed224d901a77b09"
readonly CONTROL_PORT="${FASED_H0_CONTROL_PORT:-18080}"
readonly CONTAINER_NAME="fased-tailscale-h0-$$"

for command in curl go jq podman sed sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'H0 requires %s\n' "$command" >&2
    exit 1
  }
done
for executable in /usr/bin/tailscale /usr/bin/tailscaled; do
  [[ -x "$executable" && ! -L "$executable" ]] || {
    printf 'H0 requires the fixed real executable %s\n' "$executable" >&2
    exit 1
  }
done

h0_dir="$(mktemp -d /tmp/fased-tailscale-h0.XXXXXX)"
tailscaled_pid=""
cleanup() {
  if [[ -n "$tailscaled_pid" ]]; then
    /usr/bin/tailscale --socket="$h0_dir/tailscaled.sock" logout >/dev/null 2>&1 || true
    kill "$tailscaled_pid" >/dev/null 2>&1 || true
    wait "$tailscaled_pid" >/dev/null 2>&1 || true
  fi
  podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf -- "$h0_dir"
}
trap cleanup EXIT INT TERM

printf 'H0 1/5: acquiring pinned local control-plane fixture\n'
curl -fsSL "$HEADSCALE_CONFIG_URL" -o "$h0_dir/config.yaml"
printf '%s  %s\n' "$HEADSCALE_CONFIG_SHA256" "$h0_dir/config.yaml" | sha256sum --check --status
sed -i \
  -e "s#server_url: http://127.0.0.1:8080#server_url: http://127.0.0.1:${CONTROL_PORT}#" \
  -e 's#listen_addr: 127.0.0.1:8080#listen_addr: 0.0.0.0:8080#' \
  -e 's#metrics_listen_addr: 127.0.0.1:9090#metrics_listen_addr: ""#' \
  -e 's#disable_check_updates: false#disable_check_updates: true#' \
  -e 's#base_domain: example.com#base_domain: fased-h0.test#' \
  -e 's#  auto_update_enabled: true#  auto_update_enabled: false#' \
  "$h0_dir/config.yaml"
chmod 0777 "$h0_dir"
chmod 0644 "$h0_dir/config.yaml"

printf 'H0 2/5: starting digest-pinned Headscale on loopback\n'
podman run -d --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${CONTROL_PORT}:8080" \
  -v "$h0_dir:/var/lib/headscale:Z" \
  "$HEADSCALE_IMAGE" serve -c /var/lib/headscale/config.yaml >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${CONTROL_PORT}/health" | jq -e '.status == "pass"' >/dev/null
podman exec "$CONTAINER_NAME" headscale users create fased-h0 >/dev/null
user_id="$(podman exec "$CONTAINER_NAME" headscale users list --output json | jq -er '.[] | select(.name == "fased-h0") | .id')"
podman exec "$CONTAINER_NAME" headscale preauthkeys create \
  --user "$user_id" --expiration 15m --output json | jq -ej '.key' >"$h0_dir/headscale-auth-key"
# The production boundary intentionally accepts only Tailscale SaaS tskey-auth
# files. The H0 runner swaps this non-secret validator fixture for Headscale's
# hskey-auth file only at the disposable CLI boundary.
jq -jn '"tskey-auth-fasedH0ValidatorOnly"' >"$h0_dir/auth-key"
chmod 0600 "$h0_dir/auth-key" "$h0_dir/headscale-auth-key"

printf 'H0 3/5: starting isolated real tailscaled userspace daemon\n'
/usr/bin/tailscaled \
  --tun=userspace-networking \
  --state="$h0_dir/tailscaled.state" \
  --socket="$h0_dir/tailscaled.sock" \
  --port=0 \
  --no-logs-no-support >"$h0_dir/tailscaled.log" 2>&1 &
tailscaled_pid="$!"
for _ in $(seq 1 30); do
  [[ -S "$h0_dir/tailscaled.sock" ]] && break
  kill -0 "$tailscaled_pid" 2>/dev/null || {
    sed -n '1,160p' "$h0_dir/tailscaled.log" >&2
    exit 1
  }
  sleep 1
done
[[ -S "$h0_dir/tailscaled.sock" ]]

printf 'H0 4/5: exercising the Go Hosting adapter against real Tailscale\n'
(
  cd tools/fased-lifecycled
  FASED_H0_TAILSCALE_SOCKET="$h0_dir/tailscaled.sock" \
  FASED_H0_LOGIN_SERVER="http://127.0.0.1:${CONTROL_PORT}" \
  FASED_H0_AUTH_KEY_FILE="$h0_dir/auth-key" \
  FASED_H0_HEADSCALE_AUTH_KEY_FILE="$h0_dir/headscale-auth-key" \
  FASED_H0_EXPECTED_DNS_SUFFIX="fased-h0.test" \
  GOCACHE="${GOCACHE:-/tmp/fased-go-build-cache}" \
    go test -tags=tailscale_h0 ./hostsecurity -run '^TestRealTailscaleH0$' -count=1 -v
)

printf 'H0 5/5: emitting bounded supporting receipt\n'
status_json="$(/usr/bin/tailscale --socket="$h0_dir/tailscaled.sock" status --json)"
serve_json="$(/usr/bin/tailscale --socket="$h0_dir/tailscaled.sock" serve status --json)"
jq -n \
  --arg status PASS \
  --arg evidenceClass SUPPORTING \
  --arg controlPlane "headscale-v0.29.3@sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72" \
  --arg tailscaleVersion "$(/usr/bin/tailscale version | sed -n '1p')" \
  --arg dnsName "$(jq -er '.Self.DNSName | rtrimstr(".")' <<<"$status_json")" \
  --arg ipv4 "$(jq -er '[.Self.TailscaleIPs[] | select(test("^[0-9.]+$"))][0]' <<<"$status_json")" \
  --argjson serve "$serve_json" \
  '{schemaVersion:1,status:$status,evidenceClass:$evidenceClass,controlPlane:$controlPlane,tailscaleVersion:$tailscaleVersion,dnsName:$dnsName,ipv4:$ipv4,privateServe:$serve,httpsFeature:"UNAVAILABLE_IN_HEADSCALE_H0",remoteHosting:"NOT_RUN"}'
