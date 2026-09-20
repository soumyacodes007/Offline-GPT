#!/usr/bin/env sh
set -eu

OFFLINEGPT_WORKSPACE="${OFFLINEGPT_WORKSPACE:-/workspace}"
OFFLINEGPT_DATA_DIR="${OFFLINEGPT_DATA_DIR:-/data/offlinegpt-server}"
OFFLINEGPT_SIDECAR_DIR="${OFFLINEGPT_SIDECAR_DIR:-/data/sidecars}"
OFFLINEGPT_PORT="${OFFLINEGPT_PORT:-8787}"
OFFLINEGPT_TOKEN="${OFFLINEGPT_TOKEN:-microsandbox-token}"
OFFLINEGPT_HOST_TOKEN="${OFFLINEGPT_HOST_TOKEN:-microsandbox-host-token}"
OFFLINEGPT_APPROVAL_MODE="${OFFLINEGPT_APPROVAL_MODE:-auto}"
OFFLINEGPT_CORS_ORIGINS="${OFFLINEGPT_CORS_ORIGINS:-*}"
OFFLINEGPT_CONNECT_HOST="${OFFLINEGPT_CONNECT_HOST:-127.0.0.1}"
OFFLINEGPT_EXTENSIONS_PLUGIN_DIR="${OFFLINEGPT_EXTENSIONS_PLUGIN_DIR:-/opt/offlinegpt/opencode-plugins}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export OFFLINEGPT_DATA_DIR OFFLINEGPT_TOKEN OFFLINEGPT_HOST_TOKEN OFFLINEGPT_EXTENSIONS_PLUGIN_DIR
export OFFLINEGPT_MANAGE_OPENCODE=1
export OFFLINEGPT_OPENCODE_BIN=/usr/local/bin/opencode

mkdir -p "$OFFLINEGPT_WORKSPACE" "$OFFLINEGPT_DATA_DIR" "$OFFLINEGPT_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting OfflineGPT micro-sandbox"
printf '%s\n' "- workspace: $OFFLINEGPT_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- offlinegpt url: http://$OFFLINEGPT_CONNECT_HOST:$OFFLINEGPT_PORT"
printf '%s\n' "- client token: $OFFLINEGPT_TOKEN"
printf '%s\n' "- host token: $OFFLINEGPT_HOST_TOKEN"
printf '%s\n' "- health: curl http://$OFFLINEGPT_CONNECT_HOST:$OFFLINEGPT_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $OFFLINEGPT_TOKEN\" http://$OFFLINEGPT_CONNECT_HOST:$OFFLINEGPT_PORT/workspaces"

exec offlinegpt-server \
  --workspace "$OFFLINEGPT_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$OFFLINEGPT_PORT" \
  --token "$OFFLINEGPT_TOKEN" \
  --host-token "$OFFLINEGPT_HOST_TOKEN" \
  --approval "$OFFLINEGPT_APPROVAL_MODE" \
  --cors "$OFFLINEGPT_CORS_ORIGINS" \
  --verbose
