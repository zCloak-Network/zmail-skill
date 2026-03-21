#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
CONFIRM="${ZMAIL_KIND17_V2_RESET_CONFIRM:-}"

message_count=0
if [ -d "$ZMAIL_HOME/mailboxes" ]; then
  message_count="$(
    find "$ZMAIL_HOME/mailboxes" -type f \( -name 'inbox.jsonl' -o -name 'sent.jsonl' \) -exec cat {} + 2>/dev/null \
      | wc -l \
      | tr -d ' '
  )"
fi

if [ "$CONFIRM" != "YES" ]; then
  printf 'Kind 17 v2 mailbox reset will clear local mailbox cache under %s\n' "$ZMAIL_HOME" >&2
  printf 'Estimated cached local messages: %s\n' "$message_count" >&2
  if [ -t 0 ]; then
    printf 'Type YES to continue: ' >&2
    read -r answer
    if [ "$answer" != "YES" ]; then
      printf 'Mailbox reset cancelled.\n' >&2
      exit 1
    fi
  else
    printf 'Refusing to clear mailbox cache without ZMAIL_KIND17_V2_RESET_CONFIRM=YES.\n' >&2
    exit 1
  fi
fi

rm -rf "$ZMAIL_HOME/mailboxes" "$ZMAIL_HOME/results" "$ZMAIL_HOME/cache"
mkdir -p "$ZMAIL_HOME/mailboxes" "$ZMAIL_HOME/results" "$ZMAIL_HOME/cache"

printf 'zMail mailbox cache reset at %s\n' "$ZMAIL_HOME"
