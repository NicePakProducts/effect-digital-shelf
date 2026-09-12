#!/usr/bin/env bash
# Median, min and max server time per route (time to first byte minus the TLS
# handshake), plus the cf-placement header naming where the Worker ran.
#   scripts/latency.sh https://shelf-dev.apps.npbrands.au [samples]
set -euo pipefail

base=${1:?usage: latency.sh <base-url> [samples]}
samples=${2:-7}
routes=(/api/v1/ping /health /api/v1/brands /api/v1/nope)

printf '%-16s %8s %8s %8s  %s\n' route median min max placement

for route in "${routes[@]}"; do
  values=()

  for _ in $(seq 1 "$samples"); do
    values+=("$(curl --silent --output /dev/null \
      --write-out '%{time_starttransfer} %{time_appconnect}' "$base$route" |
      awk '{ printf "%d", ($1 - $2) * 1000 }')")
  done

  sorted=($(printf '%s\n' "${values[@]}" | sort --numeric-sort))
  placement=$(curl --silent --head "$base$route" |
    awk 'tolower($1) == "cf-placement:" { print $2 }' | tr -d '\r')

  printf '%-16s %6sms %6sms %6sms  %s\n' "$route" \
    "${sorted[$((samples / 2))]}" "${sorted[0]}" "${sorted[$((samples - 1))]}" \
    "${placement:-none}"
done
