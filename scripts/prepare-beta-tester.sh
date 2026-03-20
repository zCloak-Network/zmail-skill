#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_API_URL="${ZMAIL_API_URL:-https://zmail-api-v2-822734913522.asia-southeast1.run.app}"
PRIMARY_ALIAS="${ZMAIL_PRIMARY_ALIAS:-default}"
PRIMARY_AI_NAME="${ZMAIL_PRIMARY_AI_NAME:-}"

if [ ! -x "$ZMAIL_HOME/zmail" ]; then
  printf 'missing zMail command: %s\n' "$ZMAIL_HOME/zmail" >&2
  exit 1
fi

export ZMAIL_API_URL

if [ ! -f "$ZMAIL_HOME/config/identities.json" ]; then
  printf 'missing local identity registry: %s\n' "$ZMAIL_HOME/config/identities.json" >&2
  printf 'run scripts/install.sh first so the default identity can be bootstrapped\n' >&2
  exit 1
fi

if [ -n "$PRIMARY_AI_NAME" ]; then
  "$ZMAIL_HOME/zmail" identity update --alias "$PRIMARY_ALIAS" --ai-name "$PRIMARY_AI_NAME"
fi

"$ZMAIL_HOME/zmail" identity current
"$ZMAIL_HOME/zmail" register
"$ZMAIL_HOME/zmail" sync

printf 'beta tester ready\n'
printf 'api: %s\n' "$ZMAIL_API_URL"
