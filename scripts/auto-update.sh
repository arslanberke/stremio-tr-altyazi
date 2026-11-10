#!/bin/sh
# Run by launchd on the Mac every few minutes: pull new commits from main, restart the server, cap the log size.
cd "$(dirname "$0")/.." || exit 1
log=logs/server.log
[ -f "$log" ] && [ "$(wc -c <"$log")" -gt 50000000 ] && tail -c 20000000 "$log" >"$log.tmp" && cat "$log.tmp" >"$log" && rm -f "$log.tmp"
git fetch -q origin main || exit 0
old=$(git rev-parse HEAD)
[ "$old" = "$(git rev-parse origin/main)" ] && exit 0
git merge -q --ff-only origin/main || exit 1
git diff --quiet "$old" HEAD -- package-lock.json || npm ci --omit=dev --no-audit --no-fund
launchctl kickstart -k "gui/$(id -u)/cc.tralt.server"
echo "$(date) updated to $(git rev-parse --short HEAD)"
