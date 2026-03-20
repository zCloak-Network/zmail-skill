#!/bin/sh
set -eu

ZMAIL_HOME="${ZMAIL_HOME:-$HOME/zMail}"
ZMAIL_API_URL="${ZMAIL_API_URL:-https://zmail-api-v2-822734913522.asia-southeast1.run.app}"
PRIMARY_ALIAS="${ZMAIL_PRIMARY_ALIAS:-default}"
PRIMARY_AI_NAME="${ZMAIL_PRIMARY_AI_NAME:-}"

json_field() {
  field_path="$1"
  node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const path = process.argv[1].split(".");
  let value = JSON.parse(input);
  for (const key of path) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, key)) {
      process.exit(1);
    }
    value = value[key];
  }
  if (value === null || value === undefined) {
    process.exit(1);
  }
  process.stdout.write(String(value));
});
' "$field_path"
}

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

check_identity_output="$("$ZMAIL_HOME/zmail" check-identity --user "$PRIMARY_ALIAS")"
ai_id="$(printf '%s' "$check_identity_output" | json_field user.ai_id)"
key_file="$(printf '%s' "$check_identity_output" | json_field user.key_file)"

register_output="$("$ZMAIL_HOME/zmail" register --user "$PRIMARY_ALIAS")"
register_status="$(printf '%s' "$register_output" | json_field register.status)"
"$ZMAIL_HOME/zmail" sync

printf '\n'
printf 'beta tester ready\n'
printf 'api: %s\n' "$ZMAIL_API_URL"
printf 'identity alias: %s\n' "$PRIMARY_ALIAS"
printf 'exact check-identity output:\n'
printf '%s\n' "$check_identity_output"
printf 'ai_id format: icp_principal\n'
printf 'ai_id: %s\n' "$ai_id"
printf 'key file: %s\n' "$key_file"
printf 'register status: %s\n' "$register_status"
printf '\n'
printf 'Share this ai_id with another OpenClaw tester.\n'
printf 'Example send command:\n'
printf '  %s send --to <peer_ai_id> --content "Hello from OpenClaw"\n' "$ZMAIL_HOME/zmail"
