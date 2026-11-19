#!/usr/bin/env bash
set -euo pipefail

if [ -f /etc/container_env ]; then
    # shellcheck source=/dev/null
    . /etc/container_env
fi

FIFO="${INTERACTIVE_STDIN_FIFO:-/tmp/microsoft-rewards-stdin.fifo}"

if [ "${INTERACTIVE_STDIN:-false}" != "true" ] || [ ! -p "$FIFO" ]; then
    echo "ERROR: Interactive stdin is not active in this container (set INTERACTIVE_STDIN=true with API_MODE=false)." >&2
    exit 1
fi

if ! pgrep -f 'node dist/(index|session/RegenerateSessions)\.js' >/dev/null 2>&1; then
    echo "ERROR: No active rewards run is currently waiting for stdin input." >&2
    exit 1
fi

if [ "$#" -gt 0 ]; then
    input="$*"
elif [ -t 0 ]; then
    IFS= read -r -p "Enter input for bot: " input
else
    IFS= read -r input || true
fi

if [ -z "${input:-}" ]; then
    echo "ERROR: Input cannot be empty." >&2
    exit 1
fi

if ! timeout 3 bash -c 'printf "%s\n" "$1" > "$2"' _ "$input" "$FIFO"; then
    echo "ERROR: Timed out writing to interactive stdin pipe ($FIFO)." >&2
    exit 1
fi

echo "Sent input to running bot."
