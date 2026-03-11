#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_RUNTIME_DIR="$ZMAIL_HOME/runtime"
ZMAIL_RELEASE_BASE_URL="${ZMAIL_RELEASE_BASE_URL:-https://github.com/zCloak-Network/zmail-skill/releases/latest/download}"
ZMAIL_RUNTIME_ARCHIVE_URL="${ZMAIL_RUNTIME_ARCHIVE_URL:-$ZMAIL_RELEASE_BASE_URL/zmail-openclaw-client.tar.gz}"
PRIMARY_PEM="${ZMAIL_PRIMARY_PEM:-$HOME/.config/zcloak/ai-id.pem}"
PRIMARY_ALIAS="${ZMAIL_PRIMARY_ALIAS:-default}"
PRIMARY_AI_NAME="${ZMAIL_PRIMARY_AI_NAME:-}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd tar
require_cmd node
require_cmd npm

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$ZMAIL_HOME" "$ZMAIL_HOME/config" "$ZMAIL_HOME/mailboxes" "$ZMAIL_HOME/results" "$ZMAIL_HOME/cache"

curl -fsSL "$ZMAIL_RUNTIME_ARCHIVE_URL" -o "$TMP_DIR/zmail-openclaw-client.tar.gz"
mkdir -p "$ZMAIL_RUNTIME_DIR"
rm -rf "$ZMAIL_RUNTIME_DIR"/*
tar -xzf "$TMP_DIR/zmail-openclaw-client.tar.gz" -C "$ZMAIL_RUNTIME_DIR"

cd "$ZMAIL_RUNTIME_DIR"
npm ci --omit=dev

cat > "$ZMAIL_HOME/zmail" <<EOF2
#!/bin/sh
set -eu
export ZMAIL_HOME="$ZMAIL_HOME"
exec "$ZMAIL_RUNTIME_DIR/zmail" "\$@"
EOF2
chmod +x "$ZMAIL_HOME/zmail"

if [ ! -f "$ZMAIL_HOME/config/identities.json" ] && [ -f "$PRIMARY_PEM" ]; then
  if [ -n "$PRIMARY_AI_NAME" ]; then
    "$ZMAIL_HOME/zmail" identity add --alias "$PRIMARY_ALIAS" --pem "$PRIMARY_PEM" --ai-name "$PRIMARY_AI_NAME" --default true
  else
    "$ZMAIL_HOME/zmail" identity add --alias "$PRIMARY_ALIAS" --pem "$PRIMARY_PEM" --default true
  fi
fi

printf 'zMail installed at %s\n' "$ZMAIL_HOME"
printf 'command: %s\n' "$ZMAIL_HOME/zmail"
printf 'runtime archive: %s\n' "$ZMAIL_RUNTIME_ARCHIVE_URL"
printf 'primary identity source: %s\n' "$PRIMARY_PEM"
