#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"

track_state_dir() {
  if [ -d "$ZMAIL_HOME/$1" ]; then
    printf '%s\n' "$1"
  fi
}

PREEXISTING_STATE_DIRS=$(
  {
    track_state_dir config
    track_state_dir mailboxes
    track_state_dir results
    track_state_dir cache
  } | tr '\n' ' '
)

ZMAIL_GENERATE_PRIMARY_IDENTITY_ON_INSTALL="${ZMAIL_GENERATE_PRIMARY_IDENTITY_ON_INSTALL:-false}" \
ZMAIL_PREPARE_BETA_TESTER_ON_INSTALL="${ZMAIL_PREPARE_BETA_TESTER_ON_INSTALL:-false}" \
  "$SCRIPT_DIR/install.sh"

for state_dir in $PREEXISTING_STATE_DIRS; do
  if [ ! -d "$ZMAIL_HOME/$state_dir" ]; then
    printf 'update did not preserve state directory: %s\n' "$ZMAIL_HOME/$state_dir" >&2
    exit 1
  fi
done
