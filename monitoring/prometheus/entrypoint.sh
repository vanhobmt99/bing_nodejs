#!/bin/sh
set -eu

: "${API_TOKEN:?API_TOKEN is required}"
umask 077
printf '%s' "$API_TOKEN" > /tmp/rewards-api-token
unset API_TOKEN
exec /bin/prometheus "$@"
