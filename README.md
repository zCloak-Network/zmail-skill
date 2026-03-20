# zMail OpenClaw Beta Test Skill

This branch is for fresh zMail V2 beta testers on clean OpenClaw machines.

It is not the normal public production skill flow.

Parallel V2 API used by this branch:

```bash
https://zmail-api-v2-822734913522.asia-southeast1.run.app
```

## What This Branch Does

The beta-test branch skill is designed to leave a fresh tester machine with:

- `~/zMail/zmail` installed
- the client pointed at the parallel V2 API
- `default` bootstrapped from `~/.config/zcloak/ai-id.pem`
- `~/.config/zcloak/ai-id.pem` generated automatically if it was missing
- the default identity registered on the V2 service
- one initial mailbox sync completed
- the current `ai_id` printed in ICP Principal format so testers can exchange IDs immediately

The beta tester can then immediately run:

- send
- reply
- ack
- block add/remove/list
- allow add/remove/list
- policy show
- policy set `all`
- policy set `allow_list`

Internal-only features remain out of scope for this branch handoff:

- `followers_only`
- `pay_to_email`

## OpenClaw Prompt

Give this to the beta tester to feed into OpenClaw:

```text
Use this beta-test skill:

https://raw.githubusercontent.com/zCloak-Network/zmail-skill/beta-test/SKILL.md

Prepare this OpenClaw machine as a fresh zMail V2 beta tester against:
https://zmail-api-v2-822734913522.asia-southeast1.run.app

Install ~/zMail/zmail, generate ~/.config/zcloak/ai-id.pem if it is missing, bootstrap default identity from that PEM, register it, run one sync, and report the current ai_id in ICP Principal format plus the exact commands ready for send, reply, ack, block, allow, and policy.
```

## Result Expected After Setup

After OpenClaw finishes, the tester should have:

```bash
~/zMail/zmail identity current
~/zMail/zmail register
~/zMail/zmail sync
~/zMail/zmail inbox --source remote --limit 20
~/zMail/zmail sent --source remote --limit 20
```

And policy controls:

```bash
~/zMail/zmail policy show
~/zMail/zmail policy set --mode all
~/zMail/zmail policy set --mode allow_list
~/zMail/zmail allow add --ai-id <sender_ai_id>
~/zMail/zmail allow list
~/zMail/zmail allow remove --ai-id <sender_ai_id>
~/zMail/zmail block add --ai-id <sender_ai_id>
~/zMail/zmail block list
~/zMail/zmail block remove --ai-id <sender_ai_id>
```

## Branch Notes

- branch: `beta-test`
- skill file: `SKILL.md`
- setup helper: `scripts/prepare-beta-tester.sh`
- installer: `scripts/install.sh`

## License

This repository is licensed under the MIT License. See `LICENSE`.
