#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_RUNTIME_DIR="$ZMAIL_HOME/runtime"
ZMAIL_RUNTIME_NEW_DIR="$ZMAIL_HOME/runtime.new"
ZMAIL_RUNTIME_OLD_DIR="$ZMAIL_HOME/runtime.old"
ZMAIL_RELEASE_BASE_URL="${ZMAIL_RELEASE_BASE_URL:-https://github.com/zCloak-Network/zmail-skill/releases/latest/download}"
ZMAIL_RUNTIME_ARCHIVE_URL="${ZMAIL_RUNTIME_ARCHIVE_URL:-$ZMAIL_RELEASE_BASE_URL/zmail-openclaw-client.tar.gz}"
ZMAIL_RUNTIME_ARCHIVE_SHA256_URL="${ZMAIL_RUNTIME_ARCHIVE_SHA256_URL:-$ZMAIL_RUNTIME_ARCHIVE_URL.sha256}"
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

extract_sha256() {
  awk '
    match($0, /[0-9A-Fa-f]{64}/) {
      print substr($0, RSTART, RLENGTH)
      exit
    }
  ' "$1"
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | awk '{ print $1 }'
    return
  fi

  printf 'missing required command: sha256sum, shasum, or openssl\n' >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$ZMAIL_HOME" "$ZMAIL_HOME/config" "$ZMAIL_HOME/mailboxes" "$ZMAIL_HOME/results" "$ZMAIL_HOME/cache"

curl -fsSL "$ZMAIL_RUNTIME_ARCHIVE_URL" -o "$TMP_DIR/zmail-openclaw-client.tar.gz"
curl -fsSL "$ZMAIL_RUNTIME_ARCHIVE_SHA256_URL" -o "$TMP_DIR/zmail-openclaw-client.tar.gz.sha256"

EXPECTED_SHA256=$(extract_sha256 "$TMP_DIR/zmail-openclaw-client.tar.gz.sha256" | tr '[:upper:]' '[:lower:]')
if [ -z "$EXPECTED_SHA256" ]; then
  printf 'invalid SHA256 digest file: %s\n' "$ZMAIL_RUNTIME_ARCHIVE_SHA256_URL" >&2
  exit 1
fi

ACTUAL_SHA256=$(compute_sha256 "$TMP_DIR/zmail-openclaw-client.tar.gz" | tr '[:upper:]' '[:lower:]')
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  printf 'SHA256 mismatch for runtime archive\n' >&2
  printf 'expected: %s\n' "$EXPECTED_SHA256" >&2
  printf 'actual: %s\n' "$ACTUAL_SHA256" >&2
  exit 1
fi

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
  ZMAIL_HOME="$ZMAIL_HOME" \
  ZMAIL_PRIMARY_PEM="$PRIMARY_PEM" \
  ZMAIL_PRIMARY_ALIAS="$PRIMARY_ALIAS" \
  ZMAIL_PRIMARY_AI_NAME="$PRIMARY_AI_NAME" \
  sh "$SCRIPT_DIR/bootstrap-primary-identity.sh"
fi

printf 'zMail installed at %s\n' "$ZMAIL_HOME"
printf 'command: %s\n' "$ZMAIL_HOME/zmail"
printf 'runtime archive: %s\n' "$ZMAIL_RUNTIME_ARCHIVE_URL"
printf 'primary identity source: %s\n' "$PRIMARY_PEM"
