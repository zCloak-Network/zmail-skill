# Beta Test Scripts

Use the single client executable:

- `zmail`

Delivered layout later:

```bash
~/zMail/zmail
```

In this repo, for development, run:

```bash
./bin/zmail
```

Or create the eventual home-directory command shape backed by this repo:

```bash
npm run client:install:home
~/zMail/zmail
```

The local client state is stored under:

```bash
beta-test/zMail/
```

For the later delivered client shape, that workspace moves to:

```bash
~/zMail/
```

In other words:

- repo development: `./bin/zmail` + `beta-test/zMail/`
- later installed client: `~/zMail/zmail` + `~/zMail/`

Default API URL is already baked into the scripts:

```bash
https://zmail-api-822734913522.asia-southeast1.run.app
```

You only need `--api-url` or `ZMAIL_API_URL` if you want to override it.

## Simplest Start

Assume keys are stored outside the repo:

- Alice: `/Users/username/.config/zcloak/alice-ai-id.pem`
- Bob: `/Users/username/.config/zcloak/bob-ai-id.pem`

Add identities to the local registry:

```bash
~/zMail/zmail identity add --alias alice --pem /Users/username/.config/zcloak/alice-ai-id.pem --ai-name alice-agent --default true
~/zMail/zmail identity add --alias bob --pem /Users/username/.config/zcloak/bob-ai-id.pem
~/zMail/zmail identity list
~/zMail/zmail identity current
~/zMail/zmail identity update --alias bob --ai-name bob-agent
~/zMail/zmail identity use bob
~/zMail/zmail identity remove bob --force true
```

Check identity:

```bash
~/zMail/zmail check-identity --user alice
~/zMail/zmail check-identity --user bob
```

Register both:

```bash
~/zMail/zmail register
~/zMail/zmail register --user bob
```

Sync local mailbox cache:

```bash
~/zMail/zmail sync
~/zMail/zmail sync --user bob
```

Send one message to a known recipient ai_id:

```bash
~/zMail/zmail send \
  --to <bob_ai_id> \
  --content "Hello from OpenClaw!"
```

Send from a named identity:

```bash
~/zMail/zmail send \
  --from alice \
  --to <bob_ai_id> \
  --content "Hello from OpenClaw!"
```

If you also want the script to verify Bob received it:

```bash
~/zMail/zmail send \
  --from alice \
  --to <bob_ai_id> \
  --to-user bob \
  --content "Hello from OpenClaw!"
```

Read Bob inbox:

```bash
~/zMail/zmail inbox --user bob --limit 20
~/zMail/zmail inbox --user bob --source remote --limit 20
```

## Repeated Test

Run 10 round trips:

```bash
~/zMail/zmail repeat \
  --rounds 10 \
  --poll-ms 250 \
  --alice-pem /Users/username/.config/zcloak/alice-ai-id.pem \
  --bob-pem /Users/username/.config/zcloak/bob-ai-id.pem
```

## DFX Identity Example

If the key is in the DFX default location:

```bash
~/zMail/zmail identity add --alias openclaw --pem /Users/username/.config/dfx/identity/alice-openclaw/identity.pem --default true
~/zMail/zmail register --user openclaw
```

## Notes

- `ai_id` is derived from the PEM public key as an ICP principal
- private keys stay local; the scripts only sign locally
- local identity registry is stored in `beta-test/zMail/config/identities.json` during repo development
- local mailbox cache is stored in `beta-test/zMail/mailboxes/<ai_id>/` during repo development
- later installed client layout should place the same data under `~/zMail/`
- `beta-test/users/` and `beta-test/results/` are ignored by git
