#!/usr/bin/env bash
# Renders alertmanager.mainnet.yml from the template and checks it with amtool (in the pinned image).
#   TELEGRAM_CHAT_ID=-1001234567890 ops/alertmanager/render.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
id="${TELEGRAM_CHAT_ID:-}"
if ! [[ "$id" =~ ^-?[0-9]+$ ]]; then
  echo "TELEGRAM_CHAT_ID must be the numeric chat id (e.g. -1001234567890)" >&2
  exit 1
fi
sed "s/__TELEGRAM_CHAT_ID__/${id}/" "$here/alertmanager.mainnet.tmpl.yml" > "$here/alertmanager.mainnet.yml"
echo "wrote $here/alertmanager.mainnet.yml"
if command -v docker >/dev/null 2>&1; then
  # the secrets referenced by the config must exist for amtool to accept it; use placeholders in a temp dir
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  printf 'x' > "$tmp/alert_webhook"; printf 'x' > "$tmp/telegram_token"
  sed "s#/run/secrets#/s#g" "$here/alertmanager.mainnet.yml" > "$tmp/am.yml"
  chmod 755 "$tmp"; chmod 644 "$tmp"/*
  docker run --rm -v "$tmp:/s:ro" --entrypoint amtool prom/alertmanager:v0.28.1 check-config /s/am.yml
fi
