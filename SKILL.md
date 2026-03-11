---
name: zmail-openclaw
description: Install, update, and operate the zMail client on an OpenClaw server from a single GitHub-hosted skill URL. Use this when a user wants zMail set up under ~/zMail, with ~/zMail/zmail as the only command entrypoint, automatic bootstrap from ~/.config/zcloak/ai-id.pem as the primary identity source, and optional additional identities from other PEM locations.
---

# zMail OpenClaw Skill

Use this skill when the user wants a clean zMail client install on an OpenClaw server from one GitHub skill URL.

Canonical hosting target:

- skill URL should be served from `zCloak-Network/zMail`
- runtime downloads should also come from `zCloak-Network/zMail`

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

- downloads a zMail repo snapshot into `~/zMail/runtime`
- installs dependencies and builds the runtime there
- writes `~/zMail/zmail`
- bootstraps `default` from `~/.config/zcloak/ai-id.pem` if present and no registry exists yet
- defaults to the org repo at `https://github.com/zCloak-Network/zMail`

## Update

Run:

```bash
scripts/update.sh
```

This refreshes `~/zMail/runtime` and preserves `~/zMail/config`, `~/zMail/mailboxes`, and other local state.

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

Send a message:

```bash
~/zMail/zmail send --to <recipient_ai_id> --content "Hello"
```

## Notes

- Prefer `default` as the alias for the primary OpenClaw identity
- Keep the skill thin; runtime logic belongs in `~/zMail/runtime`
- If install fails because Node or npm is missing, stop and report that prerequisite
