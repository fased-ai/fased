#!/data/data/com.termux/files/usr/bin/bash
# Quick auth check - minimal widget for Termux
# Place in ~/.shortcuts/ for Termux:Widget
#
# One-tap: shows status toast
# If expired: directly opens auth URL

SERVER="${FASED_SERVER:-}"
REMOTE_AUTH_STATUS="${FASED_REMOTE_AUTH_STATUS:-~/fased/scripts/claude-auth-status.sh}"
REMOTE_REAUTH="${FASED_REMOTE_REAUTH:-~/fased/scripts/mobile-reauth.sh}"

if [ -z "$SERVER" ]; then
    termux-toast "Set FASED_SERVER first"
    exit 2
fi

STATUS=$(ssh -o ConnectTimeout=5 "$SERVER" "$REMOTE_AUTH_STATUS simple" 2>&1)

case "$STATUS" in
    OK)
        termux-toast -s "Auth OK"
        ;;
    *EXPIRING*)
        termux-vibrate -d 100
        termux-toast "Auth expiring soon - tap again if needed"
        ;;
    *EXPIRED*|*MISSING*)
        termux-vibrate -d 200
        termux-toast "Auth expired - opening console..."
        termux-open-url "https://console.anthropic.com/settings/api-keys"
        sleep 2
        termux-notification -t "Fased Agent Re-Auth" -c "After getting key, run: ssh $SERVER '$REMOTE_REAUTH'" --id fased-auth
        ;;
    *)
        termux-toast "Connection error"
        ;;
esac
