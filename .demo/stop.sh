#!/usr/bin/env bash
d="$(cd "$(dirname "$0")" && pwd)"
[ -f "$d/stack.pid" ] && kill -INT "-$(cat "$d/stack.pid")" 2>/dev/null || kill -INT "$(cat "$d/stack.pid")" 2>/dev/null
sleep 2
for p in $(pgrep -f "[n]ext start -p 3100") $(pgrep -f "[a]nvil --port"); do kill "$p" 2>/dev/null; done
echo stopped
