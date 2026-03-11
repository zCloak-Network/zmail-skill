#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
PRIMARY_PEM="${ZMAIL_PRIMARY_PEM:-$HOME/.config/zcloak/ai-id.pem}"
PRIMARY_ALIAS="${ZMAIL_PRIMARY_ALIAS:-default}"
PRIMARY_AI_NAME="${ZMAIL_PRIMARY_AI_NAME:-}"

if [ ! -x "$ZMAIL_HOME/zmail" ]; then
  printf 'missing zMail command: %s\n' "$ZMAIL_HOME/zmail" >&2
  exit 1
fi

if [ ! -f "$PRIMARY_PEM" ]; then
  printf 'primary identity not found: %s\n' "$PRIMARY_PEM" >&2
  exit 1
fi

if [ -n "$PRIMARY_AI_NAME" ]; then
  exec "$ZMAIL_HOME/zmail" identity add --alias "$PRIMARY_ALIAS" --pem "$PRIMARY_PEM" --ai-name "$PRIMARY_AI_NAME" --default true
fi

exec "$ZMAIL_HOME/zmail" identity add --alias "$PRIMARY_ALIAS" --pem "$PRIMARY_PEM" --default true
