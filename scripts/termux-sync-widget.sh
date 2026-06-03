#!/data/data/com.termux/files/usr/bin/bash
# Fased Agent OAuth sync widget
# Runs a configured auth sync command on a reachable host.
# Place in ~/.shortcuts/ on phone for Termux:Widget

termux-toast "Syncing Fased Agent auth..."

# Run sync on the configured host.
SERVER="${FASED_SERVER:-}"
REMOTE_SYNC_CMD="${FASED_REMOTE_SYNC_CMD:-fased doctor --yes}"
REMOTE_RESTART_CMD="${FASED_REMOTE_RESTART_CMD:-systemctl --user restart fased}"

if [ -z "$SERVER" ]; then
    termux-toast "Set FASED_SERVER first"
    exit 2
fi

RESULT=$(ssh "$SERVER" "$REMOTE_SYNC_CMD" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    # Extract expiry time from output
    EXPIRY=$(echo "$RESULT" | grep "Token expires:" | cut -d: -f2-)

    termux-vibrate -d 100
    termux-toast "Fased Agent synced! Expires:${EXPIRY}"

    # Optional: restart fased service
    if [ -n "$REMOTE_RESTART_CMD" ]; then
        ssh "$SERVER" "$REMOTE_RESTART_CMD" 2>/dev/null
    fi
else
    termux-vibrate -d 300
    termux-toast "Sync failed: ${RESULT}"
fi
