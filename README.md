# zMail OpenClaw Skill

This repository distributes a Codex skill for installing and operating the zMail client on an OpenClaw server.

Current pinned production runtime tag:

- `v0.2.0-rc.1`

The skill is intentionally thin:

- `SKILL.md` defines the skill contract and user-facing usage
- `scripts/install.sh` installs or refreshes the runtime under `~/zMail`
- `scripts/update.sh` reruns install and can trigger the coordinated Kind 17 V2 mailbox-cache reset
- `scripts/bootstrap-primary-identity.sh` bootstraps the default identity from `~/.config/zcloak/ai-id.pem`
- `scripts/reset-mailbox-cache.sh` clears stale local mailbox cache while preserving identity/config
- `agents/openai.yaml` provides OpenAI-specific agent metadata

## What the installer does

- downloads the pinned public runtime bundle from GitHub releases
- extracts the runtime into `~/zMail/runtime`
- installs runtime dependencies with `npm ci --omit=dev`
- writes the `~/zMail/zmail` wrapper
- bootstraps the default identity when no local identity registry exists yet

## Directory layout

The installer creates and uses these directories under `~/zMail/`:

- `runtime/`
- `config/`
- `mailboxes/`
- `results/`
- `cache/`

## Usage

Install:

```bash
scripts/install.sh
```

Update:

```bash
scripts/update.sh
```

Coordinated Kind 17 V2 mailbox-cache reset:

```bash
ZMAIL_KIND17_V2_RESET_MAILBOXES=true \
ZMAIL_KIND17_V2_RESET_CONFIRM=YES \
scripts/update.sh
```

This preserves:

- `~/zMail/config`

This clears:

- `~/zMail/mailboxes`
- `~/zMail/results`
- `~/zMail/cache`

First commands after install:

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

## License

This repository is licensed under the MIT License. See `LICENSE`.
