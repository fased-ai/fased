#!/bin/bash
set -euo pipefail

if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -d "${XDG_RUNTIME_DIR:-/nonexistent}" || ! -w "${XDG_RUNTIME_DIR:-/nonexistent}" ]]; then
  export XDG_RUNTIME_DIR="/tmp"
fi

CONFIG_PATH="${FASED_CONFIG_PATH:-$HOME/.fased/fased.json}"
STATE_FILE="${FASED_SAT_MAINTAIN_MONITOR_STATE:-$HOME/.fased/sat-maintainer-monitor-state.json}"
MAINTAIN_LOG_FILE="${FASED_SAT_MAINTAIN_LOG_FILE:-$HOME/.fased/sat-maintainer.jsonl}"
MAX_SUCCESS_AGE_SECONDS="${FASED_SAT_MAINTAIN_MAX_SUCCESS_AGE_SECONDS:-900}"
MAX_FAILURE_STREAK="${FASED_SAT_MAINTAIN_MAX_FAILURE_STREAK:-3}"
LOW_PAYER_LAMPORTS="${FASED_SAT_MAINTAIN_LOW_PAYER_LAMPORTS:-200000000}"
RESERVE_MIN_LAMPORTS="${FASED_SAT_MAINTAIN_RESERVE_MIN_LAMPORTS:-1000000000}"
PENDING_SOL_LAMPORTS="${FASED_SAT_MAINTAIN_PENDING_SOL_LAMPORTS:-1000000}"
PENDING_SAT_RAW="${FASED_SAT_MAINTAIN_PENDING_SAT_RAW:-100000000000}"
PENDING_CYCLE_LIMIT="${FASED_SAT_MAINTAIN_PENDING_CYCLE_LIMIT:-3}"
CLEANUP_ERROR_STREAK_LIMIT="${FASED_SAT_MAINTAIN_CLEANUP_ERROR_STREAK_LIMIT:-3}"
FASED_NOTIFY_CHANNEL="${FASED_NOTIFY_CHANNEL:-}"
FASED_NOTIFY_TARGET="${FASED_NOTIFY_TARGET:-}"
FASED_NOTIFY_ACCOUNT="${FASED_NOTIFY_ACCOUNT:-}"
FASED_NOTIFY_THREAD_ID="${FASED_NOTIFY_THREAD_ID:-}"
FASED_NOTIFY_CLI="${FASED_NOTIFY_CLI:-}"
NOTIFY_PHONE="${NOTIFY_PHONE:-}"
NOTIFY_NTFY="${NOTIFY_NTFY:-}"
SELF_TEST=0
DRY_RUN=0
SELF_TEST_MESSAGE=""

usage() {
  cat <<'EOF'
usage: sat-maintainer-monitor.sh [options]

options:
  --self-test            send a synthetic SAT maintainer alert
  --dry-run              print alerts without contacting notification sinks
  --message <text>       override the self-test message
  -h, --help             show this help

watched conditions:
  no recent successful maintainer pass
  maintainer failure streak
  low maintainer/mining payer SOL
  registry reserve below launch buffer
  pending treasury/staking SAT or SOL lanes above threshold
  pending mining cycles or repeated cleanup failures
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test)
      SELF_TEST=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --message)
      SELF_TEST_MESSAGE="${2:?missing value for --message}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$(dirname "$STATE_FILE")"
NOW="$(date +%s)"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing dependency: $1" >&2
    exit 1
  fi
}

ensure_node_path() {
  if command -v node >/dev/null 2>&1; then
    return
  fi
  local candidate=""
  local path_entry
  for path_entry in "$HOME"/.nvm/versions/node/*/bin; do
    if [[ -x "$path_entry/node" ]]; then
      candidate="$path_entry"
    fi
  done
  if [[ -n "$candidate" ]]; then
    PATH="$candidate:$PATH"
    export PATH
  fi
}

ensure_node_path
require_cmd curl
require_cmd node

read_config_value() {
  local expr="$1"
  if [[ -f "$CONFIG_PATH" ]]; then
    node -e '
      const fs = require("fs");
      const [path, expr] = process.argv.slice(1);
      const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
      const fn = new Function("cfg", `return ${expr};`);
      const value = fn(cfg);
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    ' "$CONFIG_PATH" "$expr" 2>/dev/null || true
  fi
}

GATEWAY_PORT="${FASED_GATEWAY_PORT:-$(read_config_value 'cfg?.gateway?.port')}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_TOKEN="${FASED_GATEWAY_TOKEN:-$(read_config_value 'cfg?.gateway?.auth?.token')}"

has_fased_notify_sink() {
  [[ -n "$FASED_NOTIFY_CHANNEL" && -n "$FASED_NOTIFY_TARGET" ]]
}

run_fased_cli() {
  if command -v fased >/dev/null 2>&1; then
    fased "$@"
    return
  fi
  if [[ -n "$FASED_NOTIFY_CLI" && -f "$FASED_NOTIFY_CLI" ]]; then
    node "$FASED_NOTIFY_CLI" "$@"
    return
  fi
  return 127
}

gateway_get() {
  local path="$1"
  curl -fsS -H "Authorization: Bearer ${GATEWAY_TOKEN}" "http://127.0.0.1:${GATEWAY_PORT}${path}"
}

send_notification() {
  local message="$1"
  local priority="${2:-default}"
  local strict_send="${3:-0}"
  local delivered_sinks=0
  local attempted_sinks=0

  echo "$(date '+%Y-%m-%d %H:%M:%S') - ${message}"

  if (( DRY_RUN == 1 )); then
    if has_fased_notify_sink; then
      echo "dry-run: would send Fased channel alert via ${FASED_NOTIFY_CHANNEL} to ${FASED_NOTIFY_TARGET}"
    fi
    if [[ -n "$NOTIFY_PHONE" ]]; then
      echo "dry-run: would send phone alert to ${NOTIFY_PHONE}"
    fi
    if [[ -n "$NOTIFY_NTFY" ]]; then
      echo "dry-run: would post ntfy alert to https://ntfy.sh/${NOTIFY_NTFY}"
    fi
    if ! has_fased_notify_sink && [[ -z "$NOTIFY_PHONE" && -z "$NOTIFY_NTFY" ]]; then
      echo "dry-run: no notification sink configured"
    fi
    return
  fi

  if has_fased_notify_sink; then
    attempted_sinks=$((attempted_sinks + 1))
    SEND_ARGS=(message send --channel "$FASED_NOTIFY_CHANNEL" --target "$FASED_NOTIFY_TARGET" --message "$message")
    if [[ -n "$FASED_NOTIFY_ACCOUNT" ]]; then
      SEND_ARGS+=(--account "$FASED_NOTIFY_ACCOUNT")
    fi
    if [[ -n "$FASED_NOTIFY_THREAD_ID" ]]; then
      SEND_ARGS+=(--thread-id "$FASED_NOTIFY_THREAD_ID")
    fi
    if run_fased_cli "${SEND_ARGS[@]}" >/dev/null 2>&1; then
      delivered_sinks=$((delivered_sinks + 1))
    elif (( strict_send == 1 )); then
      echo "failed to send Fased channel alert via ${FASED_NOTIFY_CHANNEL} to ${FASED_NOTIFY_TARGET}" >&2
    fi
  fi

  if [[ -n "$NOTIFY_PHONE" ]]; then
    attempted_sinks=$((attempted_sinks + 1))
    if run_fased_cli send --to "$NOTIFY_PHONE" --message "$message" >/dev/null 2>&1; then
      delivered_sinks=$((delivered_sinks + 1))
    elif (( strict_send == 1 )); then
      echo "failed to send phone alert to ${NOTIFY_PHONE}" >&2
    fi
  fi

  if [[ -n "$NOTIFY_NTFY" ]]; then
    attempted_sinks=$((attempted_sinks + 1))
    if curl -s -o /dev/null \
      -H "Title: SAT Maintainer Alert" \
      -H "Priority: ${priority}" \
      -H "Tags: warning,coin" \
      -d "$message" \
      "https://ntfy.sh/${NOTIFY_NTFY}"; then
      delivered_sinks=$((delivered_sinks + 1))
    elif (( strict_send == 1 )); then
      echo "failed to post ntfy alert to https://ntfy.sh/${NOTIFY_NTFY}" >&2
    fi
  fi

  if (( strict_send == 1 )) && (( attempted_sinks > 0 )) && (( delivered_sinks == 0 )); then
    return 1
  fi
}

read_state_json() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{}'
    return
  fi
  local raw
  raw="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [[ -z "$raw" ]]; then
    echo '{}'
    return
  fi
  STATE_RAW="$raw" node - <<'NODE'
const raw = String(process.env.STATE_RAW ?? "").trim();
try {
  const parsed = raw ? JSON.parse(raw) : {};
  process.stdout.write(JSON.stringify(parsed && typeof parsed === "object" ? parsed : {}));
} catch {
  process.stdout.write("{}");
}
NODE
}

if (( SELF_TEST == 1 )); then
  if [[ -n "$FASED_NOTIFY_CHANNEL" && -z "$FASED_NOTIFY_TARGET" ]]; then
    echo "FASED_NOTIFY_CHANNEL is set but FASED_NOTIFY_TARGET is missing" >&2
    exit 1
  fi
  if [[ -z "$FASED_NOTIFY_CHANNEL" && -n "$FASED_NOTIFY_TARGET" ]]; then
    echo "FASED_NOTIFY_TARGET is set but FASED_NOTIFY_CHANNEL is missing" >&2
    exit 1
  fi
  if ! has_fased_notify_sink && [[ -z "$NOTIFY_PHONE" && -z "$NOTIFY_NTFY" ]]; then
    echo "no notification sink configured; set FASED_NOTIFY_CHANNEL+FASED_NOTIFY_TARGET, NOTIFY_NTFY, and/or NOTIFY_PHONE before --self-test" >&2
    exit 1
  fi
  if [[ -z "$SELF_TEST_MESSAGE" ]]; then
    SELF_TEST_MESSAGE="SAT maintainer monitor self-test on ${HOSTNAME:-localhost} at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  send_notification "$SELF_TEST_MESSAGE" "high" 1
  echo "SAT maintainer monitor self-test completed"
  exit 0
fi

if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "missing gateway token; set FASED_GATEWAY_TOKEN or gateway.auth.token" >&2
  exit 1
fi

STATE_JSON="$(read_state_json)"

if ! STATUS_JSON="$(gateway_get "/api/mining/status" 2>&1)"; then
  STATUS_JSON="$(printf '{"error":%s}' "$(STATUS_ERROR="$STATUS_JSON" node -e 'process.stdout.write(JSON.stringify(process.env.STATUS_ERROR || "gateway status request failed"))')")"
fi
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_JSON_FILE="$TMP_DIR/state.json"
STATUS_JSON_FILE="$TMP_DIR/status.json"
printf '%s' "$STATE_JSON" >"$STATE_JSON_FILE"
printf '%s' "$STATUS_JSON" >"$STATUS_JSON_FILE"

ANALYSIS_JSON="$(
  NOW="$NOW" \
  STATE_JSON_FILE="$STATE_JSON_FILE" \
  STATUS_JSON_FILE="$STATUS_JSON_FILE" \
  MAINTAIN_LOG_FILE="$MAINTAIN_LOG_FILE" \
  MAX_SUCCESS_AGE_SECONDS="$MAX_SUCCESS_AGE_SECONDS" \
  MAX_FAILURE_STREAK="$MAX_FAILURE_STREAK" \
  LOW_PAYER_LAMPORTS="$LOW_PAYER_LAMPORTS" \
  RESERVE_MIN_LAMPORTS="$RESERVE_MIN_LAMPORTS" \
  PENDING_SOL_LAMPORTS="$PENDING_SOL_LAMPORTS" \
  PENDING_SAT_RAW="$PENDING_SAT_RAW" \
  PENDING_CYCLE_LIMIT="$PENDING_CYCLE_LIMIT" \
  CLEANUP_ERROR_STREAK_LIMIT="$CLEANUP_ERROR_STREAK_LIMIT" \
  node - <<'NODE'
const fs = require("fs");

function parseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseBigInt(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function formatSol(lamports) {
  const value = parseBigInt(lamports);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 1000000000n;
  const fraction = (abs % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "").slice(0, 4);
  return `${sign}${whole}${fraction ? `.${fraction}` : ""} SOL`;
}

function formatSat(raw) {
  const value = parseBigInt(raw);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 100000000000n;
  const fraction = (abs % 100000000000n).toString().padStart(11, "0").replace(/0+$/, "").slice(0, 4);
  return `${sign}${whole}${fraction ? `.${fraction}` : ""} SAT`;
}

function readLogRecords(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseJson(line, null))
      .filter((record) => record && typeof record === "object");
  } catch {
    return [];
  }
}

function cleanupHadProblem(record) {
  const submitted = record?.result?.submitted;
  if (!Array.isArray(submitted)) {
    return false;
  }
  return submitted.some((entry) => {
    if (entry?.action !== "cleanupResolvedCycleAccounts") {
      return false;
    }
    const skipped = String(entry?.skipped ?? "").toLowerCase();
    return skipped && skipped !== "no-resolved-accounts";
  });
}

const now = Number(process.env.NOW || "0");
const previous = parseJson(fs.readFileSync(process.env.STATE_JSON_FILE || "/dev/null", "utf8"), {});
const statusEnvelope = parseJson(fs.readFileSync(process.env.STATUS_JSON_FILE || "/dev/null", "utf8"), {});
const status =
  statusEnvelope?.status && typeof statusEnvelope.status === "object"
    ? statusEnvelope.status
    : statusEnvelope?.payload && typeof statusEnvelope.payload === "object"
      ? statusEnvelope.payload
      : {};
const records = readLogRecords(process.env.MAINTAIN_LOG_FILE || "");
const thresholds = {
  maxSuccessAgeSeconds: Number(process.env.MAX_SUCCESS_AGE_SECONDS || "900"),
  maxFailureStreak: Number(process.env.MAX_FAILURE_STREAK || "3"),
  lowPayerLamports: parseBigInt(process.env.LOW_PAYER_LAMPORTS || "200000000"),
  reserveMinLamports: parseBigInt(process.env.RESERVE_MIN_LAMPORTS || "1000000000"),
  pendingSolLamports: parseBigInt(process.env.PENDING_SOL_LAMPORTS || "1000000"),
  pendingSatRaw: parseBigInt(process.env.PENDING_SAT_RAW || "100000000000"),
  pendingCycleLimit: Number(process.env.PENDING_CYCLE_LIMIT || "3"),
  cleanupErrorStreakLimit: Number(process.env.CLEANUP_ERROR_STREAK_LIMIT || "3"),
};

let lastSuccess = null;
let lastRecord = null;
let failureStreak = 0;
let cleanupErrorStreak = 0;
for (let index = records.length - 1; index >= 0; index -= 1) {
  const record = records[index];
  if (!lastRecord) {
    lastRecord = record;
  }
  if (record.status === "success" && !lastSuccess) {
    lastSuccess = record;
  }
  if (!lastSuccess && record.status === "failure") {
    failureStreak += 1;
  }
  if (cleanupHadProblem(record)) {
    cleanupErrorStreak += 1;
  } else if (record.status === "success") {
    cleanupErrorStreak = 0;
  }
}

const lastSuccessEpoch = lastSuccess?.ts ? Math.floor(Date.parse(lastSuccess.ts) / 1000) : 0;
const lastSuccessAgeSeconds = lastSuccessEpoch > 0 ? Math.max(0, now - lastSuccessEpoch) : null;
const noRecentSuccess =
  !lastSuccess || lastSuccessAgeSeconds == null || lastSuccessAgeSeconds > thresholds.maxSuccessAgeSeconds;
const failureStreakAlert = failureStreak >= thresholds.maxFailureStreak;
const walletLamports = parseBigInt(status.currentSolBalanceLamports);
const lowPayer = walletLamports > 0n && walletLamports < thresholds.lowPayerLamports;
const reserveLamports = parseBigInt(status.registryReserveLamports);
const reserveShortfall = reserveLamports < thresholds.reserveMinLamports;
const pendingTreasurySol = parseBigInt(status.treasuryPendingTreasurySolLamports);
const pendingStakingSol = parseBigInt(status.treasuryPendingStakingSolLamports);
const pendingTreasurySat = parseBigInt(status.treasuryPendingTreasurySatRaw);
const pendingStakingSat = parseBigInt(status.treasuryPendingStakingSatRaw);
const pendingLanes =
  pendingTreasurySol + pendingStakingSol >= thresholds.pendingSolLamports ||
  pendingTreasurySat + pendingStakingSat >= thresholds.pendingSatRaw;
const pendingCycleCount = Number(status.currentCapitalPendingCycleCount || 0);
const pendingCycleBacklog = Number.isFinite(pendingCycleCount) && pendingCycleCount > thresholds.pendingCycleLimit;
const cleanupFailures = cleanupErrorStreak >= thresholds.cleanupErrorStreakLimit;
const gatewayError = typeof statusEnvelope?.error === "string" ? statusEnvelope.error : null;

const current = {
  gatewayError: Boolean(gatewayError),
  noRecentSuccess,
  failureStreakAlert,
  lowPayer,
  reserveShortfall,
  pendingLanes,
  pendingCycleBacklog,
  cleanupFailures,
};
const previousAlerts =
  previous?.alerts && typeof previous.alerts === "object" ? previous.alerts : {};
const lines = [];
function changedAlert(key, active, activeText, clearedText) {
  if (Boolean(previousAlerts[key]) === active) {
    return;
  }
  lines.push(active ? activeText : clearedText);
}

changedAlert(
  "gatewayError",
  current.gatewayError,
  `Gateway status probe failed: ${gatewayError}`,
  "Gateway status probe recovered.",
);
changedAlert(
  "noRecentSuccess",
  current.noRecentSuccess,
  lastSuccess
    ? `No recent maintainer success: last successful pass was ${lastSuccessAgeSeconds}s ago at ${lastSuccess.ts}.`
    : "No successful SAT maintainer pass exists in the configured log.",
  "SAT maintainer success freshness recovered.",
);
changedAlert(
  "failureStreakAlert",
  current.failureStreakAlert,
  `SAT maintainer failure streak is ${failureStreak}. Latest error: ${String(lastRecord?.error ?? "unknown")}`,
  "SAT maintainer failure streak cleared.",
);
changedAlert(
  "lowPayer",
  current.lowPayer,
  `Maintainer/mining payer SOL is low: ${formatSol(walletLamports)}; threshold ${formatSol(thresholds.lowPayerLamports)}.`,
  "Maintainer/mining payer SOL recovered above threshold.",
);
changedAlert(
  "reserveShortfall",
  current.reserveShortfall,
  `Registry reserve below launch buffer: ${formatSol(reserveLamports)}; target ${formatSol(thresholds.reserveMinLamports)}.`,
  "Registry reserve recovered above launch buffer.",
);
changedAlert(
  "pendingLanes",
  current.pendingLanes,
  `Protocol lanes pending above threshold: treasury ${formatSat(pendingTreasurySat)} / ${formatSol(pendingTreasurySol)}, staking ${formatSat(pendingStakingSat)} / ${formatSol(pendingStakingSol)}.`,
  "Protocol pending lanes drained below threshold.",
);
changedAlert(
  "pendingCycleBacklog",
  current.pendingCycleBacklog,
  `Mining pending-cycle backlog is ${pendingCycleCount}; threshold ${thresholds.pendingCycleLimit}.`,
  "Mining pending-cycle backlog recovered below threshold.",
);
changedAlert(
  "cleanupFailures",
  current.cleanupFailures,
  `Cleanup/reclaim has ${cleanupErrorStreak} consecutive problem passes.`,
  "Cleanup/reclaim problem streak cleared.",
);

const nextState = {
  version: 1,
  updatedAt: new Date(now * 1000).toISOString(),
  lastSuccessAt: lastSuccess?.ts ?? null,
  lastSuccessAgeSeconds,
  failureStreak,
  cleanupErrorStreak,
  alerts: current,
};

process.stdout.write(JSON.stringify({ lines, nextState }));
NODE
)"

MESSAGE="$(
  ANALYSIS_JSON="$ANALYSIS_JSON" HOST_TEXT="${HOSTNAME:-localhost}" node - <<'NODE'
const analysis = JSON.parse(process.env.ANALYSIS_JSON || "{}");
const lines = Array.isArray(analysis.lines) ? analysis.lines : [];
if (lines.length === 0) {
  process.exit(0);
}
const host = String(process.env.HOST_TEXT || "localhost");
process.stdout.write(`SAT maintainer alert on ${host}\n\n${lines.join("\n")}`);
NODE
)"

if [[ -n "$MESSAGE" ]]; then
  send_notification "$MESSAGE" "high"
fi

NEXT_STATE_JSON="$(
  ANALYSIS_JSON="$ANALYSIS_JSON" node - <<'NODE'
const analysis = JSON.parse(process.env.ANALYSIS_JSON || "{}");
process.stdout.write(JSON.stringify(analysis.nextState ?? { version: 1 }));
NODE
)"
printf '%s\n' "$NEXT_STATE_JSON" > "$STATE_FILE"

if [[ -n "$MESSAGE" ]]; then
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') - SAT maintainer monitor OK"
