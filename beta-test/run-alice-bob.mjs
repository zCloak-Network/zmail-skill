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
const defaultApiUrl = 'https://zmail-api-822734913522.asia-southeast1.run.app';

function usage() {
  console.error('Usage: ./beta-test/alice-bob [<api-url>] [options]');
  console.error('Options:');
  console.error('  --alice-pem <path>');
  console.error('  --bob-pem <path>');
  console.error('  --alice-dfx-identity <name>');
  console.error('  --bob-dfx-identity <name>');
}

function parseArgs(argv) {
  const raw = argv.slice(2);
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  let apiUrl = '';
  let start = 0;
  if (args[0] && !args[0].startsWith('--')) {
    apiUrl = args[0];
    start = 1;
  }

  const flags = {};
  for (let index = start; index < args.length; index += 1) {
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

  return { apiUrl, flags };
}

const parsedArgs = parseArgs(process.argv);
const apiUrlInput = process.env.ZMAIL_API_URL ?? parsedArgs.apiUrl ?? defaultApiUrl;
if (parsedArgs.flags.help === 'true' || parsedArgs.flags.h === 'true' || process.argv[2] === '--help' || process.argv[2] === '-h') {
  usage();
  process.exit(0);
}

if (!apiUrlInput) {
  usage();
  process.exit(1);
}

const apiBaseUrl = apiUrlInput.endsWith('/') ? apiUrlInput.slice(0, -1) : apiUrlInput;
const runId = `alice-bob-${Date.now()}`;
const timeoutMs = Number(process.env.ZMAIL_BETA_TIMEOUT_MS ?? '90000');

async function loadOrCreateUser(label) {
  return resolveUserIdentity(label, usersDir, {
    pemPath: parsedArgs.flags[`${label}-pem`],
    dfxIdentity: parsedArgs.flags[`${label}-dfx-identity`],
    createIfMissing: true
  });
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

async function fetchJson(method, apiPath, body, headers = {}) {
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

function createRegisterBody(user, nameSuffix) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    ai_id: user.ai_id,
    public_key_spki: user.public_key_spki,
    schnorr_pubkey: user.schnorr_pubkey,
    name: `${nameSuffix}-${user.label}`,
    timestamp,
    sig: signHashHex(
      computeRegisterMessageHash(user.ai_id, user.public_key_spki, user.schnorr_pubkey, timestamp),
      user.private_key
    )
  };
}

async function registerUser(user) {
  const body = createRegisterBody(user, 'beta-user');
  const result = await fetchJson('POST', '/v1/register', body);

  if (result.status === 201) {
    return { status: 'created', response: result.body };
  }
  if (result.status === 409 && result.body?.error === 'already_registered') {
    return { status: 'already_registered', response: result.body };
  }

  throw new Error(`register failed for ${user.label}: status=${result.status} body=${JSON.stringify(result.body)}`);
}

function buildEnvelope(sender, recipient, directionLabel) {
  const createdAt = Math.floor(Date.now() / 1000);
  const unsigned = {
    kind: 17,
    ai_id: sender.ai_id,
    created_at: createdAt,
    tags: [['to', recipient.ai_id]],
    content: `beta:${runId}:${directionLabel}`
  };
  const id = computeEnvelopeId(unsigned);
  return {
    ...unsigned,
    id,
    sig: signHashHex(id, sender.private_key)
  };
}

async function waitForInboxMessage(recipient, msgId) {
  const deadline = Date.now() + timeoutMs;
  const pathName = `/v1/inbox/${recipient.ai_id}`;
  const query = new URLSearchParams({ limit: '20' });

  while (Date.now() < deadline) {
    const response = await fetchJson(
      'GET',
      `${pathName}?${query.toString()}`,
      undefined,
      createOwnershipHeaders(recipient, 'GET', pathName, query, undefined)
    );
    assert.equal(response.status, 200, `inbox request failed: ${JSON.stringify(response.body)}`);
    const messages = Array.isArray(response.body?.messages) ? response.body.messages : [];
    const delivered = messages.find((entry) => entry?.id === msgId);
    if (delivered) {
      return response.body;
    }
    await sleep(1000);
  }

  throw new Error(`timed out waiting for inbox message (${msgId})`);
}

async function verifySentMessage(sender, msgId) {
  const pathName = `/v1/sent/${sender.ai_id}`;
  const query = new URLSearchParams({ limit: '20' });
  const response = await fetchJson(
    'GET',
    `${pathName}?${query.toString()}`,
    undefined,
    createOwnershipHeaders(sender, 'GET', pathName, query, undefined)
  );
  assert.equal(response.status, 200, `sent request failed: ${JSON.stringify(response.body)}`);
  const messages = Array.isArray(response.body?.messages) ? response.body.messages : [];
  assert(messages.some((entry) => entry?.id === msgId), `sent endpoint missing ${msgId}`);
}

async function ackMessage(recipient, msgId) {
  const body = {
    ai_id: recipient.ai_id,
    msg_ids: [msgId]
  };
  const pathName = '/v1/ack';
  const response = await fetchJson(
    'POST',
    pathName,
    body,
    createOwnershipHeaders(recipient, 'POST', pathName, undefined, body)
  );
  assert.equal(response.status, 200, `ack failed: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.acked, 1, `unexpected ack count: ${JSON.stringify(response.body)}`);
}

async function runDirection(sender, recipient, directionLabel) {
  const envelope = buildEnvelope(sender, recipient, directionLabel);
  const sendResponse = await fetchJson('POST', '/v1/send', envelope);
  assert.equal(sendResponse.status, 200, `send failed (${directionLabel}): ${JSON.stringify(sendResponse.body)}`);
  assert.equal(sendResponse.body?.msg_id, envelope.id, 'send response msg_id mismatch');

  const inbox = await waitForInboxMessage(recipient, envelope.id);
  await verifySentMessage(sender, envelope.id);
  await ackMessage(recipient, envelope.id);

  return {
    direction: directionLabel,
    msg_id: envelope.id,
    received_at: sendResponse.body?.received_at ?? null,
    recipient_unread_count_before_ack: inbox?.unread_count ?? null
  };
}

async function writeResultFile(payload) {
  await ensureDir(resultsDir);
  const latestPath = path.join(resultsDir, 'latest.json');
  await fs.writeFile(latestPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return latestPath;
}

async function main() {
  const alice = await loadOrCreateUser('alice');
  const bob = await loadOrCreateUser('bob');

  const aliceRegister = await registerUser(alice);
  const bobRegister = await registerUser(bob);

  const aliceToBob = await runDirection(alice, bob, 'alice-to-bob');
  const bobToAlice = await runDirection(bob, alice, 'bob-to-alice');

  const result = {
    ok: true,
    run_id: runId,
    api_url: apiBaseUrl,
    users: {
      alice: {
        ai_id: alice.ai_id,
        public_key_spki: alice.public_key_spki,
        schnorr_pubkey: alice.schnorr_pubkey,
        key_file: alice.file_path,
        key_created_this_run: alice.created,
        register_status: aliceRegister.status
      },
      bob: {
        ai_id: bob.ai_id,
        public_key_spki: bob.public_key_spki,
        schnorr_pubkey: bob.schnorr_pubkey,
        key_file: bob.file_path,
        key_created_this_run: bob.created,
        register_status: bobRegister.status
      }
    },
    exchanges: [aliceToBob, bobToAlice]
  };

  const outputPath = await writeResultFile(result);
  console.log(JSON.stringify({
    ...result,
    result_file: outputPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
