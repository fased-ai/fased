#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${FASED_SAT_MAINTAIN_MONITOR_SERVICE_NAME:-fased-sat-maintainer-monitor.service}"
TIMER_NAME="${FASED_SAT_MAINTAIN_MONITOR_TIMER_NAME:-fased-sat-maintainer-monitor.timer}"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_TARGET="$USER_SYSTEMD_DIR/$SERVICE_NAME"
TIMER_TARGET="$USER_SYSTEMD_DIR/$TIMER_NAME"
ENV_FILE="${FASED_SAT_MAINTAIN_MONITOR_ENV_FILE:-$HOME/.fased/sat-maintainer-monitor.env}"
NODE_BIN_PATH="$(command -v node 2>/dev/null || true)"
SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
if [[ -n "$NODE_BIN_PATH" ]]; then
  SERVICE_PATH="$(dirname "$NODE_BIN_PATH"):$SERVICE_PATH"
fi

mkdir -p "$USER_SYSTEMD_DIR" "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<ENV
# Fased Agent SAT protocol maintainer monitor settings.
# The monitor reads the Fased gateway and ~/.fased/sat-maintainer.jsonl.
FASED_SAT_MAINTAIN_MAX_SUCCESS_AGE_SECONDS=900
FASED_SAT_MAINTAIN_MAX_FAILURE_STREAK=3
FASED_SAT_MAINTAIN_LOW_PAYER_LAMPORTS=200000000
FASED_SAT_MAINTAIN_RESERVE_MIN_LAMPORTS=1000000000
FASED_SAT_MAINTAIN_PENDING_SOL_LAMPORTS=1000000
FASED_SAT_MAINTAIN_PENDING_SAT_RAW=100000000000
FASED_SAT_MAINTAIN_PENDING_CYCLE_LIMIT=3
FASED_SAT_MAINTAIN_CLEANUP_ERROR_STREAK_LIMIT=3
FASED_SAT_MAINTAIN_LOG_FILE=$HOME/.fased/sat-maintainer.jsonl
FASED_SAT_MAINTAIN_MONITOR_STATE=$HOME/.fased/sat-maintainer-monitor-state.json

# Optional notification sinks. Leave empty to log locally only.
FASED_NOTIFY_CHANNEL=
FASED_NOTIFY_TARGET=
FASED_NOTIFY_ACCOUNT=
FASED_NOTIFY_THREAD_ID=
NOTIFY_NTFY=
NOTIFY_PHONE=
ENV
fi

cat >"$SERVICE_TARGET" <<UNIT
[Unit]
Description=SAT protocol maintainer health monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=PATH=$SERVICE_PATH
EnvironmentFile=-$ENV_FILE
ExecStart=/bin/bash $SCRIPT_DIR/sat-maintainer-monitor.sh

[Install]
WantedBy=default.target
UNIT

cat >"$TIMER_TARGET" <<UNIT
[Unit]
Description=Run SAT protocol maintainer health monitor every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_NAME"
systemctl --user --no-pager status "$TIMER_NAME"
