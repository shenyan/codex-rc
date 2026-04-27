#!/usr/bin/env bash
# Install / uninstall the codex-rc-ws LaunchAgent.
#
#   bin/install-launchd.sh install        # render plist + launchctl load
#   bin/install-launchd.sh uninstall      # launchctl unload + remove plist
#   bin/install-launchd.sh status         # launchctl list, recent log lines
#
# Idempotent: re-running `install` just refreshes the plist and reloads.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.user.codex-rc-ws"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE="$REPO/launchd/${LABEL}.plist"
LOG_DIR="$HOME/.codex/logs"
LOG_OUT="$LOG_DIR/codex-rc-ws.log"
LOG_ERR="$LOG_DIR/codex-rc-ws.err.log"

cmd="${1:-status}"

ensure_bun() {
  BUN="$(command -v bun || true)"
  if [ -z "$BUN" ]; then
    echo "error: 'bun' not found on PATH; install bun first (curl -fsSL https://bun.sh/install | bash)"
    exit 1
  fi
}

render_and_load() {
  ensure_bun
  mkdir -p "$LOG_DIR" "$(dirname "$DEST")"
  # Build the substituted plist with `|` as sed delimiter so the values
  # (which contain `/`) don't need escaping. Values still need `&` and
  # `|` escaped, but those are vanishingly rare in $HOME / $PATH.
  esc() { printf '%s' "$1" | sed -e 's/[|&]/\\&/g'; }
  local home_esc bun_esc repo_esc path_esc
  home_esc=$(esc "$HOME")
  bun_esc=$(esc "$BUN")
  repo_esc=$(esc "$REPO")
  path_esc=$(esc "$PATH")

  sed \
    -e "s|{{HOME}}|${home_esc}|g" \
    -e "s|{{BUN}}|${bun_esc}|g" \
    -e "s|{{REPO}}|${repo_esc}|g" \
    -e "s|{{PATH}}|${path_esc}|g" \
    "$TEMPLATE" > "$DEST"

  # Reload: unload-then-load is more reliable than `launchctl kickstart` on
  # older macOS where the env vars wouldn't refresh in place.
  launchctl unload "$DEST" 2>/dev/null || true
  launchctl load -w "$DEST"
  echo "loaded: $DEST"
  echo "logs:   $LOG_OUT"
  echo "        $LOG_ERR"
}

case "$cmd" in
  install)
    render_and_load
    ;;
  uninstall)
    if [ -f "$DEST" ]; then
      launchctl unload "$DEST" 2>/dev/null || true
      rm -f "$DEST"
      echo "removed: $DEST"
    else
      echo "(nothing to remove; $DEST does not exist)"
    fi
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      launchctl list | grep "$LABEL"
    else
      echo "not loaded"
    fi
    if [ -f "$LOG_OUT" ]; then
      echo
      echo "── tail -n 20 $LOG_OUT ──"
      tail -n 20 "$LOG_OUT"
    fi
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
