#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_RUNTIME_DIR="$ZMAIL_HOME/runtime"
ZMAIL_RUNTIME_NEW_DIR="$ZMAIL_HOME/runtime.new"
ZMAIL_RUNTIME_OLD_DIR="$ZMAIL_HOME/runtime.old"
ZMAIL_RUNTIME_RELEASE_TAG="${ZMAIL_RUNTIME_RELEASE_TAG:-v0.2.0-rc.1}"
ZMAIL_RELEASE_BASE_URL="${ZMAIL_RELEASE_BASE_URL:-https://github.com/zCloak-Network/zmail-skill/releases/download/$ZMAIL_RUNTIME_RELEASE_TAG}"
ZMAIL_RUNTIME_ARCHIVE_URL="${ZMAIL_RUNTIME_ARCHIVE_URL:-$ZMAIL_RELEASE_BASE_URL/zmail-openclaw-client.tar.gz}"
PRIMARY_PEM="${ZMAIL_PRIMARY_PEM:-$HOME/.config/zcloak/ai-id.pem}"

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
rm -rf "$ZMAIL_RUNTIME_NEW_DIR" "$ZMAIL_RUNTIME_OLD_DIR"
mkdir -p "$ZMAIL_RUNTIME_NEW_DIR"
tar -xzf "$TMP_DIR/zmail-openclaw-client.tar.gz" -C "$ZMAIL_RUNTIME_NEW_DIR"

cd "$ZMAIL_RUNTIME_NEW_DIR"
npm ci --omit=dev

if [ -d "$ZMAIL_RUNTIME_DIR" ]; then
  mv "$ZMAIL_RUNTIME_DIR" "$ZMAIL_RUNTIME_OLD_DIR"
fi
mv "$ZMAIL_RUNTIME_NEW_DIR" "$ZMAIL_RUNTIME_DIR"
rm -rf "$ZMAIL_RUNTIME_OLD_DIR"

cat > "$ZMAIL_HOME/zmail" <<EOF2
#!/bin/sh
set -eu
export ZMAIL_HOME="$ZMAIL_HOME"
exec "$ZMAIL_RUNTIME_DIR/zmail" "\$@"
EOF2
chmod +x "$ZMAIL_HOME/zmail"

if [ ! -f "$ZMAIL_HOME/config/identities.json" ] && [ -f "$PRIMARY_PEM" ]; then
  "$(dirname "$0")/bootstrap-primary-identity.sh"
fi

printf 'zMail installed at %s\n' "$ZMAIL_HOME"
printf 'command: %s\n' "$ZMAIL_HOME/zmail"
printf 'runtime archive: %s\n' "$ZMAIL_RUNTIME_ARCHIVE_URL"
printf 'runtime release tag: %s\n' "$ZMAIL_RUNTIME_RELEASE_TAG"
printf 'primary identity source: %s\n' "$PRIMARY_PEM"
