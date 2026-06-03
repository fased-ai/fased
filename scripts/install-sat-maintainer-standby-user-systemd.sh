#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="${FASED_SAT_MAINTAIN_STANDBY_SERVICE_NAME:-fased-sat-maintainer-standby.service}"
TIMER_NAME="${FASED_SAT_MAINTAIN_STANDBY_TIMER_NAME:-fased-sat-maintainer-standby.timer}"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_TARGET="$USER_SYSTEMD_DIR/$SERVICE_NAME"
TIMER_TARGET="$USER_SYSTEMD_DIR/$TIMER_NAME"
ENV_FILE="${FASED_SAT_MAINTAIN_ENV_FILE:-$HOME/.fased/sat-maintainer.env}"
NODE_BIN_PATH="$(command -v node 2>/dev/null || true)"
SERVICE_PATH="/usr/local/bin:/usr/bin:/bin"
if [[ -n "$NODE_BIN_PATH" ]]; then
  SERVICE_PATH="$(dirname "$NODE_BIN_PATH"):$SERVICE_PATH"
fi

mkdir -p "$USER_SYSTEMD_DIR" "$(dirname "$ENV_FILE")"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<ENV
# Fased Agent SAT protocol maintenance loop settings.
# Primary and standby both use this env file and the same lock.
FASED_SAT_MAINTAIN_INTERVAL_SECONDS=300
FASED_SAT_MAINTAIN_JITTER_SECONDS=30
FASED_SAT_MAINTAIN_MIN_SOL_LAMPORTS=1
FASED_SAT_MAINTAIN_MIN_SAT_RAW=1
FASED_SAT_MAINTAIN_CLEANUP_MAX_CYCLES=3
FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS=1000000000
FASED_SAT_MAINTAIN_LOG_FILE=$HOME/.fased/sat-maintainer.jsonl
FASED_SAT_MAINTAIN_LOCK_FILE=$HOME/.fased/sat-maintainer.lock
ENV
fi

if ! grep -q '^PNPM_BIN=' "$ENV_FILE" && command -v pnpm >/dev/null 2>&1; then
  printf 'PNPM_BIN=%s\n' "$(command -v pnpm)" >>"$ENV_FILE"
fi

cat >"$SERVICE_TARGET" <<UNIT
[Unit]
Description=Fased Agent SAT protocol maintainer standby pass
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$AGENT_DIR
Environment=FASED_AGENT_DIR=$AGENT_DIR
Environment=PATH=$SERVICE_PATH
EnvironmentFile=-$ENV_FILE
ExecStart=/bin/bash $SCRIPT_DIR/run-sat-maintainer-standby-agent.sh

[Install]
WantedBy=default.target
UNIT

cat >"$TIMER_TARGET" <<UNIT
[Unit]
Description=Run SAT protocol maintainer standby every 5 minutes

[Timer]
OnBootSec=4min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_NAME"
systemctl --user --no-pager status "$TIMER_NAME"
