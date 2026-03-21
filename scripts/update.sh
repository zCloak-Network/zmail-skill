#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$SCRIPT_DIR/install.sh"

if [ "${ZMAIL_KIND17_V2_RESET_MAILBOXES:-false}" = "true" ]; then
  "$SCRIPT_DIR/reset-mailbox-cache.sh"
fi
