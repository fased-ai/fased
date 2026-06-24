#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="${FASED_SAT_MAINTAIN_SERVICE_NAME:-fased-sat-maintainer.service}"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TARGET="$USER_SYSTEMD_DIR/$SERVICE_NAME"
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
# This loop uses the Fased gateway and selected SAT/mining wallet as fee payer.
FASED_SAT_MAINTAIN_INTERVAL_SECONDS=300
FASED_SAT_MAINTAIN_JITTER_SECONDS=30
FASED_SAT_MAINTAIN_MIN_SOL_LAMPORTS=1
FASED_SAT_MAINTAIN_MIN_SAT_RAW=1
FASED_SAT_MAINTAIN_CLEANUP_MAX_CYCLES=3
FASED_SAT_MAINTAIN_TARGET_RESERVE_LAMPORTS=1000000000
FASED_SAT_MAINTAIN_LOG_FILE=$HOME/.fased/sat-maintainer.jsonl
FASED_SAT_MAINTAIN_LOCK_FILE=$HOME/.fased/sat-maintainer.lock
FASED_SAT_MAINTAIN_GATEWAY_WAIT_SECONDS=90
FASED_SAT_MAINTAIN_GATEWAY_READY_DELAY_SECONDS=20
ENV
fi

if ! grep -q '^FASED_SAT_MAINTAIN_GATEWAY_WAIT_SECONDS=' "$ENV_FILE"; then
  printf 'FASED_SAT_MAINTAIN_GATEWAY_WAIT_SECONDS=90\n' >>"$ENV_FILE"
fi
if ! grep -q '^FASED_SAT_MAINTAIN_GATEWAY_READY_DELAY_SECONDS=' "$ENV_FILE"; then
  printf 'FASED_SAT_MAINTAIN_GATEWAY_READY_DELAY_SECONDS=20\n' >>"$ENV_FILE"
fi
if ! grep -q '^PNPM_BIN=' "$ENV_FILE" && command -v pnpm >/dev/null 2>&1; then
  printf 'PNPM_BIN=%s\n' "$(command -v pnpm)" >>"$ENV_FILE"
fi

cat >"$UNIT_TARGET" <<UNIT
[Unit]
Description=Fased Agent SAT protocol maintainer
After=network-online.target fased-gateway.service
Wants=network-online.target fased-gateway.service

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR
Environment=FASED_AGENT_DIR=$AGENT_DIR
Environment=PATH=$SERVICE_PATH
EnvironmentFile=-$ENV_FILE
ExecStart=/bin/bash $SCRIPT_DIR/run-sat-maintainer-agent.sh
Restart=always
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"
systemctl --user --no-pager status "$SERVICE_NAME"
