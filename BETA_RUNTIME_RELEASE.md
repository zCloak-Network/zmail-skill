# Beta Runtime Release

Use this runbook when the `beta-test` skill branch needs a refreshed runtime bundle for OpenClaw testers.

Current pinned beta runtime release tag:

```bash
beta-test-runtime-20260320-153743
```

## Goal

Publish a beta-specific runtime bundle that contains the current V2 client code and pin the public `beta-test` skill branch to that exact asset.

Do not rely on:

```bash
releases/latest
```

That can drift to a stale runtime and produce `unsupported_content_version` against the strict V2 API.

## Source Repo

Build the runtime from the main project repo:

```bash
https://github.com/zCloak-Network/zMail
```

Use the branch or commit that contains the intended V2 client behavior.

## Build

From the `zMail` repo:

```bash
npm run client:package:runtime
```

Expected output:

```bash
out/client-runtime/zmail-openclaw-client.tar.gz
```

## Required Verification

Before publishing, confirm the runtime contains the V2 send path:

```bash
tar -xOf out/client-runtime/zmail-openclaw-client.tar.gz ./beta-test/ops.mjs | rg 'encryptForReadersV2|buildV2Content'
```

Pass when output includes both:

- `buildV2Content`
- `encryptForReadersV2`

If these are missing, do not publish the bundle.

## Publish

Create or replace the beta runtime release in `zCloak-Network/zmail-skill` with the pinned tag:

```bash
beta-test-runtime-20260320-153743
```

Example with GitHub CLI:

```bash
gh release create beta-test-runtime-20260320-153743 \
  out/client-runtime/zmail-openclaw-client.tar.gz \
  --repo zCloak-Network/zmail-skill \
  --target beta-test \
  --title "Beta Runtime 20260320-153743" \
  --notes "Pinned beta runtime bundle for the beta-test skill branch."
```

If the release already exists and only the asset needs replacement:

```bash
gh release upload beta-test-runtime-20260320-153743 \
  out/client-runtime/zmail-openclaw-client.tar.gz \
  --repo zCloak-Network/zmail-skill \
  --clobber
```

## Skill Branch Pin

The public `beta-test` skill branch installer must point to:

```bash
https://github.com/zCloak-Network/zmail-skill/releases/download/beta-test-runtime-20260320-153743/zmail-openclaw-client.tar.gz
```

Do not switch the branch back to:

```bash
https://github.com/zCloak-Network/zmail-skill/releases/latest/download/zmail-openclaw-client.tar.gz
```

## Tester Recovery

Once the runtime release is published and the branch is pinned:

1. ask testers to rerun install or update
2. verify the installed runtime contains `encryptForReadersV2`
3. retry the send against the V2 API

## Why This Exists

The strict V2 API rejects stale non-V2 clients with:

```text
unsupported_content_version
```

Pinning the runtime bundle prevents the public `beta-test` skill from silently installing an older client runtime.
