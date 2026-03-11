import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir } from './identity.mjs';
import { resolveClientHome } from './runtime-paths.mjs';

const legacyWorkspaceDirs = ['.zmail', 'zmail'];

function compareByReceivedAtDesc(left, right) {
  const leftAt = Number(left?.received_at ?? 0);
  const rightAt = Number(right?.received_at ?? 0);
  if (leftAt !== rightAt) {
    return rightAt - leftAt;
  }
  const leftId = String(left?.id ?? '');
  const rightId = String(right?.id ?? '');
  return rightId.localeCompare(leftId);
}

function filterInboxMessages(messages, options = {}) {
  return messages.filter((message) => {
    if (options.unread === true && message.read !== false) {
      return false;
    }
    if (options.unread === false && message.read !== true) {
      return false;
    }
    return true;
  });
}

function takeLimit(messages, limit) {
  return messages.slice(0, limit);
}

function mergeById(existing, incoming) {
  const map = new Map();
  for (const message of existing) {
    if (message && typeof message.id === 'string') {
      map.set(message.id, message);
    }
  }
  for (const message of incoming) {
    if (message && typeof message.id === 'string') {
      map.set(message.id, message);
    }
  }
  return [...map.values()].sort(compareByReceivedAtDesc);
}

async function readJsonLines(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeJsonLines(filePath, rows) {
  await ensureDir(path.dirname(filePath));
  const payload = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, payload.length > 0 ? `${payload}\n` : '', 'utf8');
}

async function readState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      last_inbox_sync_received_at: Number(parsed?.last_inbox_sync_received_at ?? 0),
      last_sent_sync_received_at: Number(parsed?.last_sent_sync_received_at ?? 0)
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return {
        last_inbox_sync_received_at: 0,
        last_sent_sync_received_at: 0
      };
    }
    throw error;
  }
}

async function writeState(filePath, state) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function resolveMailboxDir(cwd, aiId) {
  return path.join(resolveClientHome(cwd), 'mailboxes', aiId);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingMailboxDir(cwd, aiId) {
  const preferred = resolveMailboxDir(cwd, aiId);
  if (await pathExists(preferred)) {
    return preferred;
  }
  for (const legacyDir of legacyWorkspaceDirs) {
    const candidate = path.join(cwd, legacyDir, 'mailboxes', aiId);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return preferred;
}

function resolveInboxPath(cwd, aiId) {
  return path.join(resolveMailboxDir(cwd, aiId), 'inbox.jsonl');
}

function resolveSentPath(cwd, aiId) {
  return path.join(resolveMailboxDir(cwd, aiId), 'sent.jsonl');
}

function resolveStatePath(cwd, aiId) {
  return path.join(resolveMailboxDir(cwd, aiId), 'state.json');
}

export async function hasMailboxCache(cwd, aiId) {
  try {
    const mailboxDir = await resolveExistingMailboxDir(cwd, aiId);
    await fs.access(path.join(mailboxDir, 'state.json'));
    return true;
  } catch {
    return false;
  }
}

export async function loadMailboxCache(cwd, aiId) {
  const mailboxDir = await resolveExistingMailboxDir(cwd, aiId);
  const inbox = await readJsonLines(path.join(mailboxDir, 'inbox.jsonl'));
  const sent = await readJsonLines(path.join(mailboxDir, 'sent.jsonl'));
  const state = await readState(path.join(mailboxDir, 'state.json'));
  return { inbox, sent, state };
}

export async function syncMailboxCache(cwd, aiId, remoteInbox, remoteSent) {
  const current = await loadMailboxCache(cwd, aiId);
  const inbox = mergeById(current.inbox, Array.isArray(remoteInbox?.messages) ? remoteInbox.messages : []);
  const sent = mergeById(current.sent, Array.isArray(remoteSent?.messages) ? remoteSent.messages : []);
  const state = {
    last_inbox_sync_received_at: Math.max(
      current.state.last_inbox_sync_received_at,
      ...inbox.map((message) => Number(message?.received_at ?? 0))
    ),
    last_sent_sync_received_at: Math.max(
      current.state.last_sent_sync_received_at,
      ...sent.map((message) => Number(message?.received_at ?? 0))
    )
  };

  await writeJsonLines(resolveInboxPath(cwd, aiId), inbox);
  await writeJsonLines(resolveSentPath(cwd, aiId), sent);
  await writeState(resolveStatePath(cwd, aiId), state);

  return {
    mailbox_dir: resolveMailboxDir(cwd, aiId),
    inbox_count: inbox.length,
    sent_count: sent.length,
    state
  };
}

export async function listLocalInbox(cwd, aiId, options = {}) {
  const { inbox } = await loadMailboxCache(cwd, aiId);
  const filtered = filterInboxMessages(inbox, options);
  const sorted = [...filtered].sort(compareByReceivedAtDesc);
  const limit = Number(options.limit ?? 20);
  return {
    messages: takeLimit(sorted, limit),
    unread_count: inbox.filter((message) => message.read === false).length
  };
}

export async function listLocalSent(cwd, aiId, options = {}) {
  const { sent } = await loadMailboxCache(cwd, aiId);
  const sorted = [...sent].sort(compareByReceivedAtDesc);
  const limit = Number(options.limit ?? 20);
  return {
    messages: takeLimit(sorted, limit)
  };
}

export async function markLocalInboxMessagesRead(cwd, aiId, msgIds) {
  const ids = new Set(
    Array.isArray(msgIds)
      ? msgIds.filter((msgId) => typeof msgId === 'string' && msgId.length > 0)
      : []
  );
  if (ids.size === 0) {
    return { updated: 0, unread_count: 0 };
  }

  const current = await loadMailboxCache(cwd, aiId);
  let updated = 0;
  const inbox = current.inbox.map((message) => {
    if (!message || typeof message.id !== 'string' || !ids.has(message.id)) {
      return message;
    }
    if (message.read === true) {
      return message;
    }
    updated += 1;
    return {
      ...message,
      read: true
    };
  });

  await writeJsonLines(resolveInboxPath(cwd, aiId), inbox);

  return {
    updated,
    unread_count: inbox.filter((message) => message.read === false).length
  };
}
