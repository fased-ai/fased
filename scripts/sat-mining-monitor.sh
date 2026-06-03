#!/bin/bash
set -euo pipefail

if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -d "${XDG_RUNTIME_DIR:-/nonexistent}" || ! -w "${XDG_RUNTIME_DIR:-/nonexistent}" ]]; then
  export XDG_RUNTIME_DIR="/tmp"
fi

CONFIG_PATH="${FASED_CONFIG_PATH:-$HOME/.fased/fased.json}"
STATE_FILE="${FASED_SAT_MONITOR_STATE:-$HOME/.fased/sat-monitor-state}"
LOW_WALLET_LAMPORTS="${FASED_SAT_LOW_WALLET_LAMPORTS:-}"
LOW_WALLET_FEE_BUFFER_LAMPORTS="${FASED_SAT_LOW_WALLET_FEE_BUFFER_LAMPORTS:-250000}"
LOW_FREE_CAPITAL_LAMPORTS="${FASED_SAT_LOW_FREE_CAPITAL_LAMPORTS:-250000000}"
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
usage: sat-mining-monitor.sh [options]

options:
  --self-test            send a synthetic SAT alert without querying the gateway
  --dry-run              print what would be sent without contacting sinks
  --message <text>       override the self-test message
  -h, --help             show this help

notification env:
  FASED_NOTIFY_CHANNEL   outbound Fased channel (telegram|discord|slack|...)
  FASED_NOTIFY_TARGET    provider-specific target for `fased message send`
  FASED_NOTIFY_ACCOUNT   optional configured Fased account id
  FASED_NOTIFY_THREAD_ID optional provider thread/topic id
  FASED_NOTIFY_CLI       optional path to the built Fased CLI entry (used when `fased` is not on PATH)
  NOTIFY_NTFY            optional ntfy.sh topic
  NOTIFY_PHONE           optional phone number for legacy Fased send path
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
SAT_WALLET_ID="${FASED_SAT_WALLET_ID:-$(read_config_value 'cfg?.plugins?.entries?.["sat-mining"]?.config?.walletId')}"
SAT_MIN_SOL_BALANCE_LAMPORTS="$(read_config_value 'cfg?.plugins?.entries?.["sat-mining"]?.config?.minSolBalanceLamports')"
SAT_MIN_SOL_BALANCE_LAMPORTS="${SAT_MIN_SOL_BALANCE_LAMPORTS:-150000000}"
if [[ -z "$LOW_WALLET_LAMPORTS" ]]; then
  LOW_WALLET_LAMPORTS="$(
    MIN_LAMPORTS="$SAT_MIN_SOL_BALANCE_LAMPORTS" BUFFER_LAMPORTS="$LOW_WALLET_FEE_BUFFER_LAMPORTS" node - <<'NODE'
const min = BigInt(process.env.MIN_LAMPORTS || "150000000");
const buffer = BigInt(process.env.BUFFER_LAMPORTS || "250000");
process.stdout.write((min + buffer).toString());
NODE
  )"
fi

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
      if [[ -n "$FASED_NOTIFY_ACCOUNT" ]]; then
        echo "dry-run: would use Fased account ${FASED_NOTIFY_ACCOUNT}"
      fi
      if [[ -n "$FASED_NOTIFY_THREAD_ID" ]]; then
        echo "dry-run: would use thread/topic ${FASED_NOTIFY_THREAD_ID}"
      fi
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
      -H "Title: SAT Mining Alert" \
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
if (!raw) {
  process.stdout.write("{}");
  process.exit(0);
}
if (/^\d+$/.test(raw)) {
  process.stdout.write(
    JSON.stringify({
      version: 2,
      lastNotificationEpoch: Number(raw),
      gatewayError: null,
      running: null,
      blockedReason: null,
      lastFailure: null,
      lowWallet: false,
      lowFreeCapital: false,
      lastHourlySummaryKey: null,
      lastDailySummaryKey: null,
    }),
  );
  process.exit(0);
}
try {
  const parsed = JSON.parse(raw);
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
    SELF_TEST_MESSAGE="SAT mining monitor self-test on ${HOSTNAME:-localhost} at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
  send_notification "$SELF_TEST_MESSAGE" "high" 1
  echo "SAT mining monitor self-test completed"
  exit 0
fi

if [[ -z "$GATEWAY_TOKEN" ]]; then
  echo "missing gateway token; set FASED_GATEWAY_TOKEN or gateway.auth.token" >&2
  exit 1
fi

STATE_JSON="$(read_state_json)"

if ! STATUS_JSON="$(gateway_get "/api/mining/status" 2>&1)"; then
  ANALYSIS_JSON="$(
    NOW="$NOW" \
    STATE_JSON="$STATE_JSON" \
    STATUS_ERROR="$STATUS_JSON" \
    node - <<'NODE'
const now = Number(process.env.NOW || "0");
const rawState = String(process.env.STATE_JSON || "{}");
const statusError = String(process.env.STATUS_ERROR || "gateway status request failed").trim();
let previous = {};
try {
  previous = JSON.parse(rawState);
} catch {
  previous = {};
}
const changeLines = [];
if ((previous.gatewayError ?? null) !== statusError) {
  changeLines.push(`Gateway status probe failed: ${statusError}`);
}
const nextState = {
  version: 2,
  lastNotificationEpoch: Number(previous.lastNotificationEpoch || 0),
  gatewayError: statusError,
  running: previous.running ?? null,
  blockedReason: previous.blockedReason ?? null,
  lastFailure: previous.lastFailure ?? null,
  lowWallet: Boolean(previous.lowWallet),
  lowFreeCapital: Boolean(previous.lowFreeCapital),
  lastHourlySummaryKey: previous.lastHourlySummaryKey ?? null,
  lastDailySummaryKey: previous.lastDailySummaryKey ?? null,
};
process.stdout.write(JSON.stringify({ changeLines, summaryLines: [], dailyLines: [], nextState }));
NODE
  )"
else
  HISTORY_1H_JSON="$(gateway_get "/api/mining/history?window=1h&maxPoints=2048" 2>/dev/null || echo '{}')"
  HISTORY_24H_JSON="$(gateway_get "/api/mining/history?window=24h&maxPoints=2048" 2>/dev/null || echo '{}')"
  ANALYSIS_JSON="$(
    NOW="$NOW" \
    STATE_JSON="$STATE_JSON" \
    STATUS_JSON="$STATUS_JSON" \
    HISTORY_1H_JSON="$HISTORY_1H_JSON" \
    HISTORY_24H_JSON="$HISTORY_24H_JSON" \
    LOW_WALLET_LAMPORTS="$LOW_WALLET_LAMPORTS" \
    LOW_FREE_CAPITAL_LAMPORTS="$LOW_FREE_CAPITAL_LAMPORTS" \
    REQUIRED_WALLET_RESERVE_LAMPORTS="$LOW_WALLET_LAMPORTS" \
    node - <<'NODE'
const now = Number(process.env.NOW || "0");
const lowWalletThreshold = BigInt(process.env.LOW_WALLET_LAMPORTS || "0");
const lowFreeCapitalThreshold = BigInt(process.env.LOW_FREE_CAPITAL_LAMPORTS || "0");
const requiredWalletReserveLamports = BigInt(process.env.REQUIRED_WALLET_RESERVE_LAMPORTS || "0");
const SOL_DECIMALS = 9n;
const SAT_DECIMALS = 11n;

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

function formatUnits(value, decimals, suffix, opts = {}) {
  const amount = parseBigInt(value);
  const negative = amount < 0n;
  const base = 10n ** BigInt(decimals);
  const abs = negative ? -amount : amount;
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(Number(decimals), "0");
  const trimmed = fraction.replace(/0+$/, "").slice(0, opts.maxFractionDigits ?? 4);
  const prefix = negative ? "-" : opts.signed && amount > 0n ? "+" : "";
  return `${prefix}${whole.toString()}${trimmed ? `.${trimmed}` : ""} ${suffix}`;
}

function formatSol(value, opts = {}) {
  return formatUnits(value, SOL_DECIMALS, "SOL", opts);
}

function formatSat(value, opts = {}) {
  return formatUnits(value, SAT_DECIMALS, "SAT", opts);
}

function summarizeHistory(raw) {
  const parsed = parseJson(raw, {});
  const history = parsed?.history && typeof parsed.history === "object" ? parsed.history : {};
  const outcomes = Array.isArray(history.outcomes) ? history.outcomes : [];
  let totalSatRaw = 0n;
  let totalNetLamports = 0n;
  for (const outcome of outcomes) {
    totalSatRaw += parseBigInt(outcome?.totalSatEarnedRaw);
    totalNetLamports += parseBigInt(outcome?.netLiveCostLamports);
  }
  return {
    matchingOutcomeCount:
      Number.isFinite(Number(history.matchingOutcomeCount)) ? Number(history.matchingOutcomeCount) : outcomes.length,
    totalSatRaw,
    totalNetLamports,
    dataStartAt: history.dataStartAt ?? null,
    dataEndAt: history.dataEndAt ?? null,
  };
}

const previous = parseJson(process.env.STATE_JSON || "{}", {});
const statusEnvelope = parseJson(process.env.STATUS_JSON || "{}", {});
const status =
  statusEnvelope?.status && typeof statusEnvelope.status === "object" ? statusEnvelope.status : {};
const history1h = summarizeHistory(process.env.HISTORY_1H_JSON || "{}");
const history24h = summarizeHistory(process.env.HISTORY_24H_JSON || "{}");
const changeLines = [];
const summaryLines = [];
const dailyLines = [];

const running = status.running === true;
const enabledWanted = status.enabledWanted === true;
const blockedReason = String(status.blockedReason ?? "").trim() || null;
const lastFailure = String(status.lastFailure ?? "").trim() || null;
const walletSolLamports =
  status.currentSolBalanceLamports == null ? null : parseBigInt(status.currentSolBalanceLamports);
const walletSatRaw =
  status.currentSatBalanceRaw == null ? null : parseBigInt(status.currentSatBalanceRaw);
const capitalFundedLamports = parseBigInt(status.currentCapitalFundedLamports);
const capitalLockedLamports = parseBigInt(status.currentCapitalLockedLamports);
const capitalFreeLamports = parseBigInt(status.currentCapitalFreeLamports);
const activeCommitLamports = parseBigInt(status.activeCommitLamports);
const lowWallet = walletSolLamports != null && walletSolLamports < lowWalletThreshold;
const lowFreeCapital =
  capitalFundedLamports > 0n && capitalFreeLamports < lowFreeCapitalThreshold;

if (previous.gatewayError) {
  changeLines.push("Gateway status probe recovered.");
}
if (previous.running === true && !running) {
  changeLines.push(
    `Mining stopped. Current state: ${blockedReason ? `blocked: ${blockedReason}` : lastFailure ? `failure: ${lastFailure}` : "not running"}.`,
  );
} else if (previous.running === false && running) {
  changeLines.push("Mining resumed and is running again.");
} else if (enabledWanted && !running && previous.running == null) {
  changeLines.push(
    `Mining is not running even though it is enabled. Current state: ${blockedReason ? blockedReason : lastFailure ?? "stopped"}.`,
  );
}
if ((previous.blockedReason ?? null) !== blockedReason) {
  if (blockedReason) {
    changeLines.push(`Mining blocked: ${blockedReason}`);
  } else if (previous.blockedReason) {
    changeLines.push("Mining block cleared.");
  }
}
if ((previous.lastFailure ?? null) !== lastFailure) {
  if (lastFailure) {
    changeLines.push(`Worker failure: ${lastFailure}`);
  } else if (previous.lastFailure) {
    changeLines.push("Worker failure cleared.");
  }
}
if (Boolean(previous.lowWallet) !== lowWallet) {
  if (lowWallet) {
    changeLines.push(
      `Wallet SOL is low: ${formatSol(walletSolLamports ?? 0n)} remaining; required reserve is ${formatSol(requiredWalletReserveLamports)}.`,
    );
  } else if (previous.lowWallet) {
    changeLines.push("Wallet SOL recovered above the low-balance threshold.");
  }
}
if (Boolean(previous.lowFreeCapital) !== lowFreeCapital) {
  if (lowFreeCapital) {
    changeLines.push(
      `Free miner capital is low: ${formatSol(capitalFreeLamports)} free, ${formatSol(capitalLockedLamports)} locked.`,
    );
  } else if (previous.lowFreeCapital) {
    changeLines.push("Free miner capital recovered above the minimum entry threshold.");
  }
}

const hourKey = new Date(now * 1000).toISOString().slice(0, 13);
const dayKey = new Date(now * 1000).toISOString().slice(0, 10);
const shouldSendSummary = enabledWanted || running || history24h.matchingOutcomeCount > 0;
const stateLine = blockedReason
  ? `State: blocked | ${blockedReason}`
  : running
    ? "State: running"
    : enabledWanted
      ? "State: enabled but not running"
      : "State: stopped";
const walletLine =
  walletSatRaw == null
    ? `Wallet: ${walletSolLamports == null ? "unknown SOL" : formatSol(walletSolLamports)}`
    : `Wallet: ${walletSolLamports == null ? "unknown SOL" : formatSol(walletSolLamports)} | ${formatSat(walletSatRaw)} balance`;
const capitalLine = `Capital: ${formatSol(capitalFundedLamports)} funded | ${formatSol(capitalLockedLamports)} locked | ${formatSol(capitalFreeLamports)} free | active commit ${formatSol(activeCommitLamports)}`;

if (shouldSendSummary && previous.lastHourlySummaryKey !== hourKey) {
  summaryLines.push(
    `Last 1h: ${history1h.matchingOutcomeCount} cycles | ${formatSat(history1h.totalSatRaw)} mined | ${formatSol(history1h.totalNetLamports, { signed: true })} net`,
  );
  summaryLines.push(
    `Last 24h: ${history24h.matchingOutcomeCount} cycles | ${formatSat(history24h.totalSatRaw)} mined | ${formatSol(history24h.totalNetLamports, { signed: true })} net`,
  );
  summaryLines.push(walletLine);
  summaryLines.push(capitalLine);
  summaryLines.push(stateLine);
}

if (shouldSendSummary && previous.lastDailySummaryKey !== dayKey) {
  dailyLines.push(
    `Last 24h: ${history24h.matchingOutcomeCount} cycles | ${formatSat(history24h.totalSatRaw)} mined | ${formatSol(history24h.totalNetLamports, { signed: true })} net`,
  );
  dailyLines.push(walletLine);
  dailyLines.push(capitalLine);
  dailyLines.push(stateLine);
}

const nextState = {
  version: 2,
  lastNotificationEpoch: Number(previous.lastNotificationEpoch || 0),
  gatewayError: null,
  running,
  blockedReason,
  lastFailure,
  lowWallet,
  lowFreeCapital,
  lastHourlySummaryKey:
    shouldSendSummary && previous.lastHourlySummaryKey !== hourKey ? hourKey : previous.lastHourlySummaryKey ?? null,
  lastDailySummaryKey:
    shouldSendSummary && previous.lastDailySummaryKey !== dayKey ? dayKey : previous.lastDailySummaryKey ?? null,
};

process.stdout.write(JSON.stringify({ changeLines, summaryLines, dailyLines, nextState }));
NODE
  )"
fi

send_analysis_message() {
  local field="$1"
  local title="$2"
  local priority="$3"
  local strict_send="${4:-0}"

  local message
  message="$(
    ANALYSIS_JSON="$ANALYSIS_JSON" FIELD_NAME="$field" TITLE_TEXT="$title" HOST_TEXT="${HOSTNAME:-localhost}" \
      node - <<'NODE'
const analysis = JSON.parse(process.env.ANALYSIS_JSON || "{}");
const lines = Array.isArray(analysis?.[process.env.FIELD_NAME]) ? analysis[process.env.FIELD_NAME] : [];
if (lines.length === 0) {
  process.exit(0);
}
const title = String(process.env.TITLE_TEXT || "SAT mining update");
const host = String(process.env.HOST_TEXT || "localhost");
process.stdout.write(`${title} on ${host}\n\n${lines.join("\n")}`);
NODE
  )"
  if [[ -n "$message" ]]; then
    send_notification "$message" "$priority" "$strict_send"
  fi
}

send_analysis_message "changeLines" "SAT mining state change" "high"
send_analysis_message "summaryLines" "SAT mining hourly summary" "default"
send_analysis_message "dailyLines" "SAT mining daily summary" "default"

NEXT_STATE_JSON="$(
  ANALYSIS_JSON="$ANALYSIS_JSON" \
  node - <<'NODE'
const analysis = JSON.parse(process.env.ANALYSIS_JSON || "{}");
process.stdout.write(JSON.stringify(analysis?.nextState ?? { version: 2 }));
NODE
)"
printf '%s\n' "$NEXT_STATE_JSON" > "$STATE_FILE"

if [[ -n "$(
  ANALYSIS_JSON="$ANALYSIS_JSON" node - <<'NODE'
const analysis = JSON.parse(process.env.ANALYSIS_JSON || "{}");
const changeLines = Array.isArray(analysis.changeLines) ? analysis.changeLines : [];
process.stdout.write(changeLines.length > 0 ? "1" : "");
NODE
)" ]]; then
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') - SAT mining monitor OK"
