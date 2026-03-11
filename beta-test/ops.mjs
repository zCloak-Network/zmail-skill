#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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
import {
  addIdentityRecord,
  getCurrentIdentity,
  listIdentityRecords,
  removeIdentityRecord,
  resolveIdentityAlias,
  updateIdentityRecord,
  useIdentityAlias
} from './identity-store.mjs';
import {
  hasMailboxCache,
  listLocalInbox,
  listLocalSent,
  markLocalInboxMessagesRead,
  syncMailboxCache
} from './mailbox-store.mjs';
import { resolveClientHome } from './runtime-paths.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientHome = resolveClientHome();
const usersDir = path.join(clientHome, 'users');
const resultsDir = path.join(clientHome, 'results');
const defaultTimeoutMs = Number(process.env.ZMAIL_BETA_TIMEOUT_MS ?? '90000');
const defaultApiUrl = 'https://zmail-api-822734913522.asia-southeast1.run.app';

function usage() {
  console.log(`Usage: zmail <command> [options]

Commands:
  identity         add/list/use/current/update/remove local identities
  generate         --user <identity-source>
  check-identity   --user <identity-source>
  register         --user <identity-source> [--api-url <url>]
  send             [--from <identity-source>] --to <recipient-ai-id> --content <text> [--api-url <url>] [--register true|false]
  check-mail       --user <identity-source> --msg-id <id> [--api-url <url>] [--timeout-ms <n>]
  sync             [--user <identity-source>] [--api-url <url>] [--limit <n>]
  inbox            --user <identity-source> [--api-url <url>] [--limit <n>] [--unread true|false]
  sent             --user <identity-source> [--api-url <url>] [--limit <n>]
  ack              --user <identity-source> --msg-id <id> [--api-url <url>]
  scenario         [--api-url <url>] [--content-a <text>] [--content-b <text>] [source flags]
                  Runs: register alice+bob, send A->B + ack, send B->A + ack.

Options:
  --api-url <url>  Overrides ZMAIL_API_URL
  --timeout-ms <n> Poll timeout for check-mail (default: ${defaultTimeoutMs})
  --user <identity-source>     Identity file path, dfx:<name>, or local beta label
  --from <identity-source>     Sender identity file path, dfx:<name>, or local beta label
  --to <recipient-ai-id>       Recipient ai_id for send
  --to-user <identity-source>  Optional recipient identity for delivery verification
  --source <local|remote>      Inbox/sent source override
  Identity subcommands:
  zmail identity add --alias <alias> --pem <path> [--ai-name <name>] [--default true|false]
  zmail identity list
  zmail identity use <alias>
  zmail identity current
  zmail identity update --alias <alias> [--pem <path>] [--ai-name <name>] [--default true|false]
  zmail identity remove <alias> [--force true]
  --alice-pem <path>           Alice PEM for scenario
  --bob-pem <path>             Bob PEM for scenario
  --alice-dfx-identity <name>  Alice DFX identity for scenario
  --bob-dfx-identity <name>    Bob DFX identity for scenario
  Compatibility:
  --pem/--dfx-identity and --from-pem/--from-dfx-identity/--to-pem/--to-dfx-identity still work
`);
}

function parseArgs(argv) {
  const rest = argv.slice(2);
  const command = rest[0];
  const args = [];
  const flags = {};
  for (let i = 1; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { command, args, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (!value) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

function requireValue(value, label) {
  if (!value) {
    throw new Error(`missing ${label}`);
  }
  return value;
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

async function ensureDirs() {
  await ensureDir(usersDir);
  await ensureDir(resultsDir);
}

async function resolveIdentityAliasSource(alias) {
  if (typeof alias !== 'string' || alias.trim().length === 0) {
    return null;
  }
  return resolveIdentityAlias(alias.trim());
}

function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return input;
  }
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function looksLikePemPath(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  const normalized = value.trim();
  return normalized.endsWith('.pem')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.startsWith('~/');
}

function inferLabelFromSource(source, fallback = 'user') {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return fallback;
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('dfx:')) {
    return trimmed.slice(4) || fallback;
  }
  if (looksLikePemPath(trimmed)) {
    const expanded = expandHome(trimmed);
    const base = path.basename(expanded, path.extname(expanded));
    if (base === 'identity') {
      return path.basename(path.dirname(expanded)) || fallback;
    }
    return base || fallback;
  }
  return trimmed;
}

function resolveSingleUserSource(flags) {
  const explicit = flags.user;
  if (!explicit && !flags.pem && !flags['dfx-identity']) {
    return null;
  }
  if (flags.pem || flags['dfx-identity']) {
    return {
      label: inferLabelFromSource(explicit, 'user'),
      pemPath: flags.pem ? expandHome(flags.pem) : undefined,
      dfxIdentity: flags['dfx-identity']
    };
  }
  return {
    label: inferLabelFromSource(explicit, 'user'),
    pemPath: looksLikePemPath(explicit) ? expandHome(explicit) : undefined,
    dfxIdentity: typeof explicit === 'string' && explicit.startsWith('dfx:') ? explicit.slice(4) : undefined
  };
}

function resolveNamedSource(input, flags, prefix) {
  const legacyPem = flags[`${prefix}-pem`];
  const legacyDfx = flags[`${prefix}-dfx-identity`];
  if (legacyPem || legacyDfx) {
    return {
      label: inferLabelFromSource(input, prefix),
      pemPath: legacyPem ? expandHome(legacyPem) : undefined,
      dfxIdentity: legacyDfx
    };
  }
  return {
    label: inferLabelFromSource(input, prefix),
    pemPath: looksLikePemPath(input) ? expandHome(input) : undefined,
    dfxIdentity: typeof input === 'string' && input.startsWith('dfx:') ? input.slice(4) : undefined
  };
}

async function loadUser(label, source = {}) {
  await ensureDirs();
  const user = await resolveUserIdentity(label, usersDir, {
    ...source,
    createIfMissing: false
  });
  return { ...user, created: false, ai_name: source.aiName ?? null };
}

async function loadOrCreateUser(label, source = {}) {
  await ensureDirs();
  const user = await resolveUserIdentity(label, usersDir, {
    ...source,
    createIfMissing: true
  });
  return { ...user, ai_name: source.aiName ?? null };
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

function registerBody(user, namePrefix = 'beta-user') {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    ai_id: user.ai_id,
    public_key_spki: user.public_key_spki,
    schnorr_pubkey: user.schnorr_pubkey,
    ...(user.ai_name ? { name: user.ai_name } : { name: `${namePrefix}-${user.label}` }),
    timestamp,
    sig: signHashHex(
      computeRegisterMessageHash(user.ai_id, user.public_key_spki, user.schnorr_pubkey, timestamp),
      user.private_key
    )
  };
}

async function resolveUsableSingleUserSource(flags) {
  const direct = resolveSingleUserSource(flags);
  if (direct) {
    if (!direct.pemPath && !direct.dfxIdentity && typeof flags.user === 'string') {
      const fromRegistry = await resolveIdentityAliasSource(flags.user);
      if (fromRegistry) {
        return {
          label: fromRegistry.alias,
          pemPath: fromRegistry.pemPath,
          aiName: fromRegistry.aiName
        };
      }
    }
    return direct;
  }

  const current = await getCurrentIdentity();
  if (!current) {
    throw new Error('missing --user and no default identity configured');
  }
  return {
    label: current.alias,
    pemPath: current.pemPath,
    aiName: current.aiName
  };
}

async function resolveUsableNamedSource(input, flags, prefix, fallbackDefault = false) {
  if (!input && fallbackDefault) {
    const current = await getCurrentIdentity();
    if (!current) {
      throw new Error(`missing --${prefix} and no default identity configured`);
    }
    return {
      label: current.alias,
      pemPath: current.pemPath,
      aiName: current.aiName
    };
  }

  const direct = resolveNamedSource(input, flags, prefix);
  if (!direct.pemPath && !direct.dfxIdentity && typeof input === 'string') {
    const fromRegistry = await resolveIdentityAliasSource(input);
    if (fromRegistry) {
      return {
        label: fromRegistry.alias,
        pemPath: fromRegistry.pemPath,
        aiName: fromRegistry.aiName
      };
    }
  }
  return direct;
}

async function registerUser(apiBaseUrl, user) {
  const body = registerBody(user);
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
  assert.equal(response.body?.msg_id, envelope.id, 'send response msg_id mismatch');
  return {
    envelope,
    response: response.body
  };
}

async function listInbox(apiBaseUrl, user, options = {}) {
  const query = new URLSearchParams();
  query.set('limit', String(options.limit ?? 20));
  if (options.unread === true) {
    query.set('unread', 'true');
  } else if (options.unread === false) {
    query.set('unread', 'false');
  }
  const pathName = `/v1/inbox/${user.ai_id}`;
  const response = await fetchJson(
    apiBaseUrl,
    'GET',
    `${pathName}?${query.toString()}`,
    undefined,
    createOwnershipHeaders(user, 'GET', pathName, query, undefined)
  );
  assert.equal(response.status, 200, `inbox failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function listSent(apiBaseUrl, user, options = {}) {
  const query = new URLSearchParams();
  query.set('limit', String(options.limit ?? 20));
  const pathName = `/v1/sent/${user.ai_id}`;
  const response = await fetchJson(
    apiBaseUrl,
    'GET',
    `${pathName}?${query.toString()}`,
    undefined,
    createOwnershipHeaders(user, 'GET', pathName, query, undefined)
  );
  assert.equal(response.status, 200, `sent failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function waitForInboxMessage(apiBaseUrl, user, msgId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inbox = await listInbox(apiBaseUrl, user, { limit: 50 });
    const messages = Array.isArray(inbox?.messages) ? inbox.messages : [];
    const found = messages.find((entry) => entry?.id === msgId);
    if (found) {
      return {
        inbox,
        message: found
      };
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for message ${msgId}`);
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

async function writeLatestResult(payload) {
  await ensureDirs();
  const resultPath = path.join(resultsDir, 'latest-ops.json');
  await fs.writeFile(resultPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return resultPath;
}

async function commandGenerate(flags) {
  const source = await resolveUsableSingleUserSource(flags);
  const user = await loadOrCreateUser(source.label, source);
  console.log(JSON.stringify({
    ok: true,
    operation: 'generate',
    user: {
      label: user.label,
      ai_id: user.ai_id,
      public_key_spki: user.public_key_spki,
      schnorr_pubkey: user.schnorr_pubkey,
      key_file: user.file_path,
      created: user.created
    }
  }, null, 2));
}

async function commandCheckIdentity(flags) {
  const source = await resolveUsableSingleUserSource(flags);
  const user = await loadUser(source.label, source);
  console.log(JSON.stringify({
    ok: true,
    operation: 'check-identity',
    user: {
      label: user.label,
      ai_id: user.ai_id,
      public_key_spki: user.public_key_spki,
      schnorr_pubkey: user.schnorr_pubkey,
      key_file: user.file_path
    }
  }, null, 2));
}

async function commandRegister(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const user = await loadOrCreateUser(source.label, source);
  const register = await registerUser(apiBaseUrl, user);
  const payload = {
    ok: true,
    operation: 'register',
    api_url: apiBaseUrl,
    user: {
      label: user.label,
      ai_id: user.ai_id,
      public_key_spki: user.public_key_spki,
      schnorr_pubkey: user.schnorr_pubkey,
      key_file: user.file_path
    },
    register
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandSend(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const from = flags.from;
  const toAiId = requireFlag(flags, 'to');
  const content = requireFlag(flags, 'content');
  const shouldRegister = parseBoolean(flags.register, true);
  const timeoutMs = parsePositiveInt(flags['timeout-ms'], defaultTimeoutMs);

  const senderSource = await resolveUsableNamedSource(from, flags, 'from', true);
  const sender = await loadOrCreateUser(senderSource.label, senderSource);
  const recipientUserInput = flags['to-user'] ?? ((flags['to-pem'] || flags['to-dfx-identity']) ? toAiId : undefined);
  const recipient = recipientUserInput
    ? await loadOrCreateUser(resolveNamedSource(recipientUserInput, flags, 'to').label, resolveNamedSource(recipientUserInput, flags, 'to'))
    : { label: 'recipient', ai_id: toAiId };

  let senderRegister = null;
  let recipientRegister = null;
  if (shouldRegister) {
    senderRegister = await registerUser(apiBaseUrl, sender);
    if ('private_key' in recipient) {
      recipientRegister = await registerUser(apiBaseUrl, recipient);
    }
  }

  const sent = await sendEnvelope(apiBaseUrl, sender, recipient, content);
  const wait = 'private_key' in recipient
    ? await waitForInboxMessage(apiBaseUrl, recipient, sent.envelope.id, timeoutMs)
    : null;

  const payload = {
    ok: true,
    operation: 'send',
    api_url: apiBaseUrl,
    sender: {
      label: sender.label,
      ai_id: sender.ai_id
    },
    recipient: {
      label: recipient.label,
      ai_id: recipient.ai_id
    },
    register: {
      enabled: shouldRegister,
      sender: senderRegister,
      recipient: recipientRegister
    },
    envelope: sent.envelope,
    send_response: sent.response,
    recipient_received_event: wait?.message ?? null
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandCheckMail(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const msgId = requireFlag(flags, 'msg-id');
  const timeoutMs = parsePositiveInt(flags['timeout-ms'], defaultTimeoutMs);

  const user = await loadOrCreateUser(source.label, source);
  const found = await waitForInboxMessage(apiBaseUrl, user, msgId, timeoutMs);

  const payload = {
    ok: true,
    operation: 'check-mail',
    api_url: apiBaseUrl,
    user: {
      label: user.label,
      ai_id: user.ai_id
    },
    msg_id: msgId,
    received_event: found.message
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandSync(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const limit = parsePositiveInt(flags.limit, 100);
  const user = await loadOrCreateUser(source.label, source);
  const [inbox, sent] = await Promise.all([
    listInbox(apiBaseUrl, user, { limit }),
    listSent(apiBaseUrl, user, { limit })
  ]);
  const synced = await syncMailboxCache(process.cwd(), user.ai_id, inbox, sent);
  const payload = {
    ok: true,
    operation: 'sync',
    api_url: apiBaseUrl,
    user: {
      label: user.label,
      ai_id: user.ai_id
    },
    sync: synced
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandInbox(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const limit = parsePositiveInt(flags.limit, 20);
  const unread = flags.unread === undefined
    ? undefined
    : parseBoolean(flags.unread, undefined);

  const user = await loadOrCreateUser(source.label, source);
  const requestedSource = flags.source;
  const useLocal = requestedSource === 'local'
    || (requestedSource !== 'remote' && await hasMailboxCache(process.cwd(), user.ai_id));
  const inbox = useLocal
    ? await listLocalInbox(process.cwd(), user.ai_id, { limit, unread })
    : await listInbox(apiBaseUrl, user, { limit, unread });

  console.log(JSON.stringify({
    ok: true,
    operation: 'inbox',
    api_url: apiBaseUrl,
    source: useLocal ? 'local' : 'remote',
    user: {
      label: user.label,
      ai_id: user.ai_id
    },
    inbox
  }, null, 2));
}

async function commandSent(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const limit = parsePositiveInt(flags.limit, 20);

  const user = await loadOrCreateUser(source.label, source);
  const requestedSource = flags.source;
  const useLocal = requestedSource === 'local'
    || (requestedSource !== 'remote' && await hasMailboxCache(process.cwd(), user.ai_id));
  const sent = useLocal
    ? await listLocalSent(process.cwd(), user.ai_id, { limit })
    : await listSent(apiBaseUrl, user, { limit });

  console.log(JSON.stringify({
    ok: true,
    operation: 'sent',
    api_url: apiBaseUrl,
    source: useLocal ? 'local' : 'remote',
    user: {
      label: user.label,
      ai_id: user.ai_id
    },
    sent
  }, null, 2));
}

async function commandAck(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const source = await resolveUsableSingleUserSource(flags);
  const msgId = requireFlag(flags, 'msg-id');

  const user = await loadOrCreateUser(source.label, source);
  const ack = await ackMessage(apiBaseUrl, user, msgId);
  const cache = await hasMailboxCache(process.cwd(), user.ai_id)
    ? await markLocalInboxMessagesRead(process.cwd(), user.ai_id, [msgId])
    : null;

  const payload = {
    ok: true,
    operation: 'ack',
    api_url: apiBaseUrl,
    user: {
      label: user.label,
      ai_id: user.ai_id
    },
    msg_id: msgId,
    ack,
    cache
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandScenario(flags) {
  const apiBaseUrl = requireApiBaseUrl(flags);
  const contentA = flags['content-a'] ?? `Hello Bob from Alice (${Date.now()})`;
  const contentB = flags['content-b'] ?? `Hello Alice from Bob (${Date.now()})`;
  const timeoutMs = parsePositiveInt(flags['timeout-ms'], defaultTimeoutMs);

  const alice = await loadOrCreateUser('alice', pickUserSource(flags, 'alice', 'alice'));
  const bob = await loadOrCreateUser('bob', pickUserSource(flags, 'bob', 'bob'));

  const aliceRegister = await registerUser(apiBaseUrl, alice);
  const bobRegister = await registerUser(apiBaseUrl, bob);

  const aliceSent = await sendEnvelope(apiBaseUrl, alice, bob, contentA);
  const bobInbox = await waitForInboxMessage(apiBaseUrl, bob, aliceSent.envelope.id, timeoutMs);
  const bobAck = await ackMessage(apiBaseUrl, bob, aliceSent.envelope.id);

  const bobSent = await sendEnvelope(apiBaseUrl, bob, alice, contentB);
  const aliceInbox = await waitForInboxMessage(apiBaseUrl, alice, bobSent.envelope.id, timeoutMs);
  const aliceAck = await ackMessage(apiBaseUrl, alice, bobSent.envelope.id);

  const payload = {
    ok: true,
    operation: 'scenario',
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
    alice_to_bob: {
      envelope: aliceSent.envelope,
      send_response: aliceSent.response,
      bob_received_event: bobInbox.message,
      bob_ack: bobAck
    },
    bob_to_alice: {
      envelope: bobSent.envelope,
      send_response: bobSent.response,
      alice_received_event: aliceInbox.message,
      alice_ack: aliceAck
    }
  };
  payload.result_file = await writeLatestResult(payload);
  console.log(JSON.stringify(payload, null, 2));
}

async function commandIdentity(args, flags) {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help') {
    usage();
    return;
  }

  if (subcommand === 'add') {
    const alias = requireFlag(flags, 'alias');
    const pemPath = expandHome(requireFlag(flags, 'pem'));
    const aiName = flags['ai-name'];
    const makeDefault = parseBoolean(flags.default, false);
    const result = await addIdentityRecord({
      alias,
      pemPath,
      aiName,
      makeDefault
    });
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-add',
      ...result
    }, null, 2));
    return;
  }

  if (subcommand === 'list') {
    const result = await listIdentityRecords();
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-list',
      ...result
    }, null, 2));
    return;
  }

  if (subcommand === 'use') {
    const alias = args[1] ?? flags.alias;
    if (!alias) {
      throw new Error('missing identity alias');
    }
    const result = await useIdentityAlias(alias);
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-use',
      ...result
    }, null, 2));
    return;
  }

  if (subcommand === 'update') {
    const alias = requireFlag(flags, 'alias');
    const result = await updateIdentityRecord({
      alias,
      pemPath: flags.pem ? expandHome(flags.pem) : undefined,
      aiName: Object.prototype.hasOwnProperty.call(flags, 'ai-name') ? flags['ai-name'] : undefined,
      makeDefault: parseBoolean(flags.default, false)
    });
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-update',
      ...result
    }, null, 2));
    return;
  }

  if (subcommand === 'remove') {
    const alias = requireValue(args[1] ?? flags.alias, 'identity alias');
    const result = await removeIdentityRecord(alias, {
      force: parseBoolean(flags.force, false)
    });
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-remove',
      ...result
    }, null, 2));
    return;
  }

  if (subcommand === 'current') {
    const current = await getCurrentIdentity();
    console.log(JSON.stringify({
      ok: true,
      operation: 'identity-current',
      current
    }, null, 2));
    return;
  }

  throw new Error(`unknown identity subcommand: ${subcommand}`);
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  const handlers = {
    identity: (innerFlags) => commandIdentity(args, innerFlags),
    generate: commandGenerate,
    'check-identity': commandCheckIdentity,
    register: commandRegister,
    send: commandSend,
    'check-mail': commandCheckMail,
    sync: commandSync,
    inbox: commandInbox,
    sent: commandSent,
    ack: commandAck,
    scenario: commandScenario
  };

  const handler = handlers[command];
  if (!handler) {
    usage();
    throw new Error(`unknown command: ${command}`);
  }

  await handler(flags);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
