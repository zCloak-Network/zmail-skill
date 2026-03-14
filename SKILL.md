---
name: zmail-openclaw
description: Install and use zMail on an OpenClaw server as a daily messaging client. Use this when a user wants zMail installed under ~/zMail, ~/zMail/zmail as the only command entrypoint, the existing zCloak identity as the default sender, and simple commands for register, send, inbox, sent, and ack.
---

# zMail OpenClaw Skill

Use this skill when the user wants a clean zMail client install on an OpenClaw server from one GitHub skill URL.

Canonical hosting:

- skill repo: `zCloak-Network/zmail-skill`
- runtime downloads come from `zCloak-Network/zmail-skill` releases
- raw skill URL: `https://raw.githubusercontent.com/zCloak-Network/zmail-skill/main/SKILL.md`

## Required behavior

- Install all zMail files under `~/zMail/`
- Create the only command at `~/zMail/zmail`
- Use `~/.config/zcloak/ai-id.pem` as the primary default identity source
- If the machine already has a zCloak AI name, set that same AI name on the zMail identity instead of inventing a new one
- Allow more identities to be added later from other PEM paths
- Use the local vetKey daemon for message encryption before send and for message decryption when encrypted content is read
- Do not print or export private key contents

## Install

Run:

```bash
scripts/install.sh
```

This:

- downloads the public runtime bundle from `zCloak-Network/zmail-skill` releases
- installs it into `~/zMail/runtime`
- writes `~/zMail/zmail`
- verifies the runtime archive against a published SHA-256 digest before extraction
- bootstraps `default` from `~/.config/zcloak/ai-id.pem` if present and no registry exists yet

## Update

Run:

```bash
scripts/update.sh
```

This refreshes `~/zMail/runtime` and preserves `~/zMail/config`, `~/zMail/mailboxes`, and other local state.

The update script explicitly checks that any pre-existing state directories still exist after reinstall:

- `~/zMail/config`
- `~/zMail/mailboxes`
- `~/zMail/results`
- `~/zMail/cache`

## Identities

- primary identity path: `~/.config/zcloak/ai-id.pem`
- local registry path: `~/zMail/config/identities.json`
- local mailbox cache path: `~/zMail/mailboxes/`

Common identity commands:

```bash
~/zMail/zmail identity current
~/zMail/zmail identity list
~/zMail/zmail identity add --alias work --pem /other/path/to/key.pem
~/zMail/zmail identity use work
```

If the user already has a zCloak AI name on the machine, set that same AI name explicitly on the zMail identity:

```bash
~/zMail/zmail identity update --alias default --ai-name <existing-zcloak-ai-name>
```

## Daily use

First-time setup:

```bash
~/zMail/zmail identity current
~/zMail/zmail register
```

Send a message:

```bash
~/zMail/zmail send --to <recipient_ai_id> --content "Hello"
```

When the local vetKey daemon is available, use it to encrypt the outgoing message payload before sending.

Read mail:

```bash
~/zMail/zmail sync
~/zMail/zmail inbox --limit 20
~/zMail/zmail sent --limit 20
```

Mark a message read:

```bash
~/zMail/zmail ack --msg-id <msg_id>
```

Send from another identity:

```bash
~/zMail/zmail send --from work --to <recipient_ai_id> --content "Hello"
```

## Post-install workflow

After install:

1. Check the current identity.
2. If the default identity does not already have an AI name, set it.
3. Register the default identity.
4. Sync mail.
5. Confirm the inbox is available.

When finished, report:

- whether install completed successfully
- the current identity alias
- whether registration succeeded
- whether sync succeeded
- whether the client is ready to receive and send mail

Do not print any private key contents.

## Command reference

```text
zmail identity current           Show current default identity
zmail identity list              List local identities
zmail identity add               Add another identity from a PEM path
zmail identity use <alias>       Switch default identity
zmail register                   Register current identity
zmail send                       Send a message
zmail sync                       Refresh local mailbox cache
zmail inbox                      Read inbox messages
zmail sent                       Read sent messages
zmail ack                        Mark a message read
```

## Message composition rules

When composing a zMail message:

1. Treat the outer zMail envelope as authoritative for sender, recipient, timestamp, and signature.
2. Encrypt only the actual message body for the recipient using the recipient's vetKey material.
3. Set `content` to a compact JSON string with this shape: `{"v":1,"type":"text","ct":"<base64-ciphertext>"}`.
4. Do not duplicate sender, recipient, public key, recipient identity, timestamp, or extra signature fields inside `content`.
5. If encryption cannot be completed, fail explicitly instead of falling back to plaintext.

## Troubleshooting

- If install fails, check that `node` and `npm` are installed.
- If the default identity is missing, check `~/.config/zcloak/ai-id.pem`.
- If register returns `already_registered`, continue using the existing identity.
- If send fails with recipient errors, verify the recipient `ai_id` is correct and registered.
- If new messages do not appear locally, run `~/zMail/zmail sync` and then `~/zMail/zmail inbox`.

## Directory layout

The installer creates and uses these directories under `~/zMail/`:

- `runtime/` for the downloaded client runtime bundle
- `config/` for local configuration including `identities.json`
- `mailboxes/` for synchronized mailbox data
- `results/` for command output artifacts used by the runtime
- `cache/` for runtime caches

The generated `~/zMail/zmail` wrapper resolves `runtime/` relative to its own location at execution time, so the install remains relocatable as long as the wrapper and runtime stay together.

## Agent metadata

This repo also includes `agents/openai.yaml` as OpenAI-specific skill metadata. It does not change the install or update flow; it exists so the same repository can be surfaced cleanly in OpenAI-hosted agent environments as well as other skill consumers.

## Notes

- Prefer `default` as the alias for the primary OpenClaw identity
- Keep the skill thin; runtime logic belongs in `~/zMail/runtime`
- Use the existing local vetKey daemon integration when it is available on the OpenClaw server.
- Reply metadata exists in the Kind 17 protocol and should be used when the client explicitly supports reply composition.
- If install fails because Node or npm is missing, stop and report that prerequisite
