#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_RUNTIME_DIR="$ZMAIL_HOME/runtime"
ZMAIL_REPO_URL="${ZMAIL_REPO_URL:-https://github.com/zCloak-Network/zmail-skill}"
ZMAIL_REF="${ZMAIL_REF:-main}"
ZMAIL_ARCHIVE_URL="${ZMAIL_ARCHIVE_URL:-$ZMAIL_REPO_URL/archive/refs/heads/$ZMAIL_REF.tar.gz}"
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

curl -fsSL "$ZMAIL_ARCHIVE_URL" -o "$TMP_DIR/zmail.tar.gz"
tar -xzf "$TMP_DIR/zmail.tar.gz" -C "$TMP_DIR"

EXTRACTED_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$EXTRACTED_DIR" ]; then
  printf 'failed to extract zMail archive\n' >&2
  exit 1
fi

rm -rf "$ZMAIL_RUNTIME_DIR"
mkdir -p "$ZMAIL_RUNTIME_DIR"

cp "$EXTRACTED_DIR/package.json" "$ZMAIL_RUNTIME_DIR/"
cp "$EXTRACTED_DIR/package-lock.json" "$ZMAIL_RUNTIME_DIR/"
cp "$EXTRACTED_DIR/tsconfig.json" "$ZMAIL_RUNTIME_DIR/"
cp -R "$EXTRACTED_DIR/src" "$ZMAIL_RUNTIME_DIR/"
cp -R "$EXTRACTED_DIR/bin" "$ZMAIL_RUNTIME_DIR/"
cp -R "$EXTRACTED_DIR/beta-test" "$ZMAIL_RUNTIME_DIR/"

cd "$ZMAIL_RUNTIME_DIR"
npm ci
npm run build

cat > "$ZMAIL_HOME/zmail" <<EOF
#!/bin/sh
set -eu
export ZMAIL_HOME="$ZMAIL_HOME"
exec "$ZMAIL_RUNTIME_DIR/bin/zmail" "\$@"
EOF
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
printf 'primary identity source: %s\n' "$PRIMARY_PEM"
