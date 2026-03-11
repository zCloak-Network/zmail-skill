# zMail OpenClaw Skill

This repository distributes a Codex skill for installing and operating the zMail client on an OpenClaw server.

The skill is intentionally thin:

- `SKILL.md` defines the skill contract and user-facing usage
- `scripts/install.sh` installs or refreshes the runtime under `~/zMail`
- `scripts/update.sh` reruns install and verifies pre-existing state directories are preserved
- `scripts/bootstrap-primary-identity.sh` bootstraps the default identity from `~/.config/zcloak/ai-id.pem`
- `agents/openai.yaml` provides OpenAI-specific agent metadata

## What the installer does

- downloads the public runtime bundle from GitHub releases
- verifies the runtime archive against a published SHA-256 digest
- extracts the runtime into `~/zMail/runtime`
- installs runtime dependencies with `npm ci --omit=dev` when a lockfile is present
- falls back to `npm install --omit=dev` when `package-lock.json` is absent
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
