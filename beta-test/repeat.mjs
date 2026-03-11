#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { bytesToHex } from '@noble/curves/utils.js';
import { buildOwnershipProofHash } from '../dist/src/api/middleware/auth.js';
import { computeRegisterMessageHash } from '../dist/src/api/routes/register.js';
import { computeEnvelopeId } from '../dist/src/domain/envelope.js';
import {
  ensureDir,
  resolveUserIdentity,
  signHashHex
} from './identity.mjs';
import { resolveClientHome } from './runtime-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientHome = resolveClientHome();
const usersDir = path.join(clientHome, 'users');
const resultsDir = path.join(clientHome, 'results');
const defaultTimeoutMs = Number(process.env.ZMAIL_BETA_TIMEOUT_MS ?? '90000');
const defaultPollMs = Number(process.env.ZMAIL_BETA_POLL_MS ?? '250');
const defaultApiUrl = 'https://zmail-api-822734913522.asia-southeast1.run.app';

function usage() {
  console.log(`Usage: ./beta-test/repeat [options]

Runs repeated round trips:
  Alice -> Bob
  Bob -> Alice

Options:
  --api-url <url>              Overrides ZMAIL_API_URL
  --rounds <n>                 Number of round trips (default: 5)
  --delay-ms <n>               Delay between rounds (default: 0)
  --timeout-ms <n>             Inbox poll timeout per message (default: ${defaultTimeoutMs})
  --poll-ms <n>                Inbox poll interval (default: ${defaultPollMs})
  --ack true|false             Ack each delivered message (default: true)
  --alice-pem <path>           Alice PEM path
  --bob-pem <path>             Bob PEM path
  --alice-dfx-identity <name>  Alice DFX identity name
  --bob-dfx-identity <name>    Bob DFX identity name
  --content-prefix <text>      Prefix for generated message bodies
`);
}

function parseArgs(argv) {
  const raw = argv.slice(2);
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  const flags = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return flags;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeApiUrl(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function requireApiBaseUrl(flags) {
  const apiBaseUrl = normalizeApiUrl(flags['api-url'] ?? process.env.ZMAIL_API_URL ?? defaultApiUrl);
  if (!apiBaseUrl) {
    throw new Error('api url is required');
  }
  return apiBaseUrl;
}

function createOwnershipHeaders(user, method, pathName, query, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = bytesToHex(randomBytes(16));
  const signature = signHashHex(
    buildOwnershipProofHash({
      method,
      path: pathName,
      query,
      body,
      timestamp,
      nonce
    }),
    user.private_key
  );

  return {
    'x-zmail-ai-id': user.ai_id,
    'x-zmail-timestamp': timestamp,
    'x-zmail-nonce': nonce,
    'x-zmail-signature': signature
  };
}

async function fetchJson(apiBaseUrl, method, apiPath, body, headers = {}) {
  const response = await fetch(`${apiBaseUrl}${apiPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    body: parsed
  };
}

async function registerUser(apiBaseUrl, user) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = {
    ai_id: user.ai_id,
    public_key_spki: user.public_key_spki,
    schnorr_pubkey: user.schnorr_pubkey,
    name: `beta-repeat-${user.label}`,
    timestamp,
    sig: signHashHex(
      computeRegisterMessageHash(user.ai_id, user.public_key_spki, user.schnorr_pubkey, timestamp),
      user.private_key
    )
  };
  const response = await fetchJson(apiBaseUrl, 'POST', '/v1/register', body);
  if (response.status === 201) {
    return { status: 'created', response: response.body };
  }
  if (response.status === 409 && response.body?.error === 'already_registered') {
    return { status: 'already_registered', response: response.body };
  }
  throw new Error(`register failed (${user.label}): status=${response.status} body=${JSON.stringify(response.body)}`);
}

function buildEnvelope(sender, recipient, content) {
  const unsigned = {
    kind: 17,
    ai_id: sender.ai_id,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['to', recipient.ai_id]],
    content
  };
  const id = computeEnvelopeId(unsigned);
  return {
    ...unsigned,
    id,
    sig: signHashHex(id, sender.private_key)
  };
}

async function sendEnvelope(apiBaseUrl, sender, recipient, content) {
  const envelope = buildEnvelope(sender, recipient, content);
  const response = await fetchJson(apiBaseUrl, 'POST', '/v1/send', envelope);
  assert.equal(response.status, 200, `send failed: ${JSON.stringify(response.body)}`);
  return {
    envelope,
    response: response.body
  };
}

async function waitForInboxMessage(apiBaseUrl, user, msgId, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  const query = new URLSearchParams({ limit: '50' });
  const pathName = `/v1/inbox/${user.ai_id}`;

  while (Date.now() < deadline) {
    const response = await fetchJson(
      apiBaseUrl,
      'GET',
      `${pathName}?${query.toString()}`,
      undefined,
      createOwnershipHeaders(user, 'GET', pathName, query, undefined)
    );
    assert.equal(response.status, 200, `inbox failed: ${JSON.stringify(response.body)}`);
    const messages = Array.isArray(response.body?.messages) ? response.body.messages : [];
    const message = messages.find((entry) => entry?.id === msgId);
    if (message) {
      return message;
    }
    await sleep(pollMs);
  }

  throw new Error(`timed out waiting for ${msgId}`);
}

async function ackMessage(apiBaseUrl, user, msgId) {
  const body = {
    ai_id: user.ai_id,
    msg_ids: [msgId]
  };
  const pathName = '/v1/ack';
  const response = await fetchJson(
    apiBaseUrl,
    'POST',
    pathName,
    body,
    createOwnershipHeaders(user, 'POST', pathName, undefined, body)
  );
  assert.equal(response.status, 200, `ack failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function loadUser(label, flags) {
  await ensureDir(usersDir);
  return resolveUserIdentity(label, usersDir, {
    pemPath: flags[`${label}-pem`],
    dfxIdentity: flags[`${label}-dfx-identity`],
    createIfMissing: true
  });
}

async function writeResult(payload) {
  await ensureDir(resultsDir);
  const filePath = path.join(resultsDir, 'latest-repeat.json');
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return filePath;
}

async function runLeg(apiBaseUrl, sender, recipient, content, options) {
  const sent = await sendEnvelope(apiBaseUrl, sender, recipient, content);
  return {
    sent_message: sent.envelope,
    send_response: sent.response,
    waitForReceived: () => waitForInboxMessage(apiBaseUrl, recipient, sent.envelope.id, options.timeoutMs, options.pollMs),
    ackMessage: () => options.ack ? ackMessage(apiBaseUrl, recipient, sent.envelope.id) : Promise.resolve(null)
  };
}

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.help === 'true' || flags.h === 'true') {
    usage();
    return;
  }

  const apiBaseUrl = requireApiBaseUrl(flags);
  const rounds = parsePositiveInt(flags.rounds, 5);
  const delayMs = parseNonNegativeInt(flags['delay-ms'], 0);
  const timeoutMs = parsePositiveInt(flags['timeout-ms'], defaultTimeoutMs);
  const pollMs = parsePositiveInt(flags['poll-ms'], defaultPollMs);
  const ack = parseBoolean(flags.ack, true);
  const contentPrefix = flags['content-prefix'] ?? 'beta-repeat';

  const alice = await loadUser('alice', flags);
  const bob = await loadUser('bob', flags);

  const aliceRegister = await registerUser(apiBaseUrl, alice);
  const bobRegister = await registerUser(apiBaseUrl, bob);

  const roundsOut = [];
  const startedAt = Date.now();

  for (let round = 1; round <= rounds; round += 1) {
    const aliceContent = `${contentPrefix}:round-${round}:alice-to-bob`;
    const bobContent = `${contentPrefix}:round-${round}:bob-to-alice`;
    const [aliceToBob, bobToAlice] = await Promise.all([
      runLeg(apiBaseUrl, alice, bob, aliceContent, { timeoutMs, pollMs, ack }),
      runLeg(apiBaseUrl, bob, alice, bobContent, { timeoutMs, pollMs, ack })
    ]);

    const [aliceReceived, bobReceived] = await Promise.all([
      aliceToBob.waitForReceived(),
      bobToAlice.waitForReceived()
    ]);

    const [aliceAck, bobAck] = await Promise.all([
      aliceToBob.ackMessage(),
      bobToAlice.ackMessage()
    ]);

    roundsOut.push({
      round,
      alice_to_bob: {
        sent_message: aliceToBob.sent_message,
        send_response: aliceToBob.send_response,
        received_message: aliceReceived,
        ack: aliceAck
      },
      bob_to_alice: {
        sent_message: bobToAlice.sent_message,
        send_response: bobToAlice.send_response,
        received_message: bobReceived,
        ack: bobAck
      }
    });
    if (delayMs > 0 && round < rounds) {
      await sleep(delayMs);
    }
  }

  const payload = {
    ok: true,
    operation: 'repeat-roundtrip',
    api_url: apiBaseUrl,
    rounds,
    delay_ms: delayMs,
    poll_ms: pollMs,
    ack,
    started_at: startedAt,
    finished_at: Date.now(),
    users: {
      alice: {
        ai_id: alice.ai_id,
        key_file: alice.file_path,
        register_status: aliceRegister.status
      },
      bob: {
        ai_id: bob.ai_id,
        key_file: bob.file_path,
        register_status: bobRegister.status
      }
    },
    results: roundsOut
  };
  payload.result_file = await writeResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
