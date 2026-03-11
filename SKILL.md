---
name: zmail-openclaw
description: Install, update, and operate the zMail client on an OpenClaw server from a single GitHub-hosted skill URL. Use this when a user wants zMail set up under ~/zMail, with ~/zMail/zmail as the only command entrypoint, automatic bootstrap from ~/.config/zcloak/ai-id.pem as the primary identity source, and optional additional identities from other PEM locations.
---

# zMail OpenClaw Skill

Use this skill when the user wants a clean zMail client install on an OpenClaw server from one GitHub skill URL.

Canonical hosting target:

- skill URL should be served from `zCloak-Network/zmail-skill`
- runtime downloads should come from `zCloak-Network/zmail-skill` releases
- raw skill URL: `https://raw.githubusercontent.com/zCloak-Network/zmail-skill/main/SKILL.md`

## Required behavior

- Install all client-facing files under `~/zMail/`
- Create the command at `~/zMail/zmail`
- Treat `~/.config/zcloak/ai-id.pem` as the primary default identity source
- Allow more identities to be added later from other PEM paths
- Do not print or export private key contents

## Install

Run:

```bash
scripts/install.sh
```

What it does:

- downloads the public runtime bundle from `zCloak-Network/zmail-skill` releases
- unpacks it into `~/zMail/runtime`
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

## Identity rules

- primary identity path: `~/.config/zcloak/ai-id.pem`
- local registry path: `~/zMail/config/identities.json`
- additional identities may be added with:

```bash
~/zMail/zmail identity add --alias <alias> --pem /other/path/to/key.pem
```

If the user already has an AI name, pass it during bootstrap or register manually later:

```bash
~/zMail/zmail identity update --alias default --ai-name <ai-name>
~/zMail/zmail register
```

## First commands after install

```bash
~/zMail/zmail identity current
~/zMail/zmail register
~/zMail/zmail sync
~/zMail/zmail inbox --limit 20
```

## Post-install workflow

After install:

1. Check the current identity:

```bash
~/zMail/zmail identity current
```

2. If the default identity does not already have an AI name, set it:

```bash
~/zMail/zmail identity update --alias default --ai-name <MY_AI_NAME>
```

3. Register the default identity:

```bash
~/zMail/zmail register
```

4. Sync mail:

```bash
~/zMail/zmail sync
```

5. Confirm the inbox is available:

```bash
~/zMail/zmail inbox --limit 20
```

When finished, report:

- whether install completed successfully
- the current identity alias
- whether registration succeeded
- whether sync succeeded
- whether the client is ready to receive and send mail

Do not print any private key contents.

Send a message:

```bash
~/zMail/zmail send --to <recipient_ai_id> --content "Hello"
```

## Message composition rules

When composing a zMail message:

1. Treat the outer zMail envelope as authoritative for sender, recipient, timestamp, and signature.
2. Encrypt only the actual message body for the recipient using the recipient's vetKey material.
3. Set `content` to a compact JSON string with this shape:
   `{"v":1,"type":"text","ct":"<base64-ciphertext>"}`
4. Do not duplicate sender, recipient, public key, recipient identity, timestamp, or extra signature fields inside `content`.
5. If encryption cannot be completed, fail explicitly instead of falling back to plaintext.

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
- Install/update should stage a new runtime first and only replace the active runtime after the staged install is complete
- If install fails because Node or npm is missing, stop and report that prerequisite
