#!/bin/sh
set -eu

PRIMARY_PEM="${ZMAIL_PRIMARY_PEM:-$HOME/.config/zcloak/ai-id.pem}"
PRIMARY_DIR=$(dirname -- "$PRIMARY_PEM")

if [ -f "$PRIMARY_PEM" ]; then
  printf 'primary identity already exists: %s\n' "$PRIMARY_PEM"
  exit 0
fi

command -v node >/dev/null 2>&1 || {
  printf 'missing required command: node\n' >&2
  exit 1
}

mkdir -p "$PRIMARY_DIR"

PRIMARY_PEM="$PRIMARY_PEM" node <<'EOF'
const { generateKeyPairSync } = require('node:crypto');
const { mkdirSync, openSync, writeFileSync, closeSync, renameSync, chmodSync } = require('node:fs');
const { dirname } = require('node:path');

const target = process.env.PRIMARY_PEM;
if (!target) {
  throw new Error('missing PRIMARY_PEM');
}

mkdirSync(dirname(target), { recursive: true });

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'secp256k1',
  privateKeyEncoding: {
    format: 'pem',
    type: 'sec1'
  }
});

const temp = `${target}.tmp`;
const fd = openSync(temp, 'w', 0o600);
try {
  writeFileSync(fd, privateKey, 'utf8');
} finally {
  closeSync(fd);
}
chmodSync(temp, 0o600);
renameSync(temp, target);
EOF

chmod 600 "$PRIMARY_PEM"
printf 'generated new primary identity: %s\n' "$PRIMARY_PEM"
