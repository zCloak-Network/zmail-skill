import type { Kind17Envelope } from '../domain/envelope.js';
import { extractRecipients } from '../domain/recipients.js';

export interface StoredInboxMessage extends Kind17Envelope {
  read: boolean;
  received_at: number;
  delivered_at: number;
}

export interface StoredSentMessage extends Kind17Envelope {
  received_at: number;
  stored_at: number;
  recipients: string[];
}

export interface InboxQuery {
  limit?: number;
  after?: string;
  unread?: boolean;
  from?: string;
}

export interface SentQuery {
  limit?: number;
  after?: string;
  to?: string;
}

export interface InboxQueryResult {
  messages: StoredInboxMessage[];
  cursor?: string;
  unread_count: number;
}

export interface SentQueryResult {
  messages: StoredSentMessage[];
  cursor?: string;
}

export interface MailboxStore {
  writeInboxMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, deliveredAt: number): Promise<void>;
  writeSentMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, storedAt: number): Promise<void>;
  listInbox(aiId: string, query: InboxQuery): Promise<InboxQueryResult>;
  listSent(aiId: string, query: SentQuery): Promise<SentQueryResult>;
  ackInbox(aiId: string, msgIds: string[]): Promise<number>;
  clear(): void;
}

function cloneInboxMessage(message: StoredInboxMessage): StoredInboxMessage {
  return {
    id: message.id,
    kind: message.kind,
    ai_id: message.ai_id,
    created_at: message.created_at,
    tags: message.tags.map((tag) => [...tag]) as Kind17Envelope['tags'],
    content: typeof message.content === 'string' ? message.content : { ...message.content },
    sig: message.sig,
    read: message.read,
    received_at: message.received_at,
    delivered_at: message.delivered_at
  };
}

function cloneSentMessage(message: StoredSentMessage): StoredSentMessage {
  return {
    id: message.id,
    kind: message.kind,
    ai_id: message.ai_id,
    created_at: message.created_at,
    tags: message.tags.map((tag) => [...tag]) as Kind17Envelope['tags'],
    content: typeof message.content === 'string' ? message.content : { ...message.content },
    sig: message.sig,
    received_at: message.received_at,
    stored_at: message.stored_at,
    recipients: [...message.recipients]
  };
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) {
    return 20;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return 20;
  }
  return Math.min(limit, 100);
}

function sortByReceivedAtDesc<T extends { received_at: number; id: string }>(messages: T[]): T[] {
  return [...messages].sort((left, right) => {
    if (right.received_at !== left.received_at) {
      return right.received_at - left.received_at;
    }
    return right.id.localeCompare(left.id);
  });
}

interface CursorPayloadV1 {
  v: 1;
  r: number;
  i: string;
}

function encodeCursor(receivedAtUnix: number, id: string): string {
  const payload: CursorPayloadV1 = {
    v: 1,
    r: receivedAtUnix,
    i: id
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `v1.${encoded}`;
}

function decodeCursor(cursor: string): CursorPayloadV1 {
  if (!cursor.startsWith('v1.')) {
    throw new Error('invalid_cursor');
  }

  const encoded = cursor.slice(3);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_cursor');
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as { v?: unknown }).v !== 1
    || !Number.isInteger((parsed as { r?: unknown }).r)
    || typeof (parsed as { i?: unknown }).i !== 'string'
    || ((parsed as { i?: string }).i?.length ?? 0) === 0
  ) {
    throw new Error('invalid_cursor');
  }

  return parsed as CursorPayloadV1;
}

function applyAfterCursor<T extends { id: string; received_at: number }>(messages: T[], after?: string): T[] {
  if (!after) {
    return messages;
  }

  const cursor = decodeCursor(after);
  return messages.filter((message) => {
    if (message.received_at < cursor.r) {
      return true;
    }
    if (message.received_at === cursor.r && message.id < cursor.i) {
      return true;
    }
    return false;
  });
}

export class InMemoryMailboxStore implements MailboxStore {
  private readonly inbox = new Map<string, Map<string, StoredInboxMessage>>();
  private readonly sent = new Map<string, Map<string, StoredSentMessage>>();

  async writeInboxMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, deliveredAt: number): Promise<void> {
    const mailbox = this.inbox.get(aiId) ?? new Map<string, StoredInboxMessage>();
    const existing = mailbox.get(envelope.id);
    if (existing) {
      mailbox.set(envelope.id, {
        ...existing,
        received_at: existing.received_at,
        delivered_at: existing.delivered_at
      });
    } else {
      mailbox.set(envelope.id, {
        ...envelope,
        read: false,
        received_at: receivedAt,
        delivered_at: deliveredAt
      });
    }
    this.inbox.set(aiId, mailbox);
  }

  async writeSentMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, storedAt: number): Promise<void> {
    const mailbox = this.sent.get(aiId) ?? new Map<string, StoredSentMessage>();
    const existing = mailbox.get(envelope.id);
    if (existing) {
      mailbox.set(envelope.id, {
        ...existing,
        received_at: existing.received_at,
        stored_at: existing.stored_at
      });
    } else {
      mailbox.set(envelope.id, {
        ...envelope,
        received_at: receivedAt,
        stored_at: storedAt,
        recipients: extractRecipients(envelope.tags)
      });
    }
    this.sent.set(aiId, mailbox);
  }

  async listInbox(aiId: string, query: InboxQuery): Promise<InboxQueryResult> {
    const mailbox = this.inbox.get(aiId);
    const allMessages = mailbox ? Array.from(mailbox.values()) : [];
    const unreadCount = allMessages.reduce((total, message) => total + (message.read ? 0 : 1), 0);

    const filtered = allMessages.filter((message) => {
      if (query.unread === true && message.read) {
        return false;
      }
      if (query.from && message.ai_id !== query.from) {
        return false;
      }
      return true;
    });

    const sorted = sortByReceivedAtDesc(filtered);
    const afterApplied = applyAfterCursor(sorted, query.after);
    const limit = normalizeLimit(query.limit);
    const paged = afterApplied.slice(0, limit);
    let cursor: string | undefined;
    if (afterApplied.length > limit) {
      const last = paged[paged.length - 1];
      if (last) {
        cursor = encodeCursor(last.received_at, last.id);
      }
    }

    const result: InboxQueryResult = {
      messages: paged.map((message) => cloneInboxMessage(message)),
      unread_count: unreadCount
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  }

  async listSent(aiId: string, query: SentQuery): Promise<SentQueryResult> {
    const mailbox = this.sent.get(aiId);
    const allMessages = mailbox ? Array.from(mailbox.values()) : [];

    const filtered = allMessages.filter((message) => {
      if (query.to && !message.recipients.includes(query.to)) {
        return false;
      }
      return true;
    });

    const sorted = sortByReceivedAtDesc(filtered);
    const afterApplied = applyAfterCursor(sorted, query.after);
    const limit = normalizeLimit(query.limit);
    const paged = afterApplied.slice(0, limit);
    let cursor: string | undefined;
    if (afterApplied.length > limit) {
      const last = paged[paged.length - 1];
      if (last) {
        cursor = encodeCursor(last.received_at, last.id);
      }
    }

    const result: SentQueryResult = {
      messages: paged.map((message) => cloneSentMessage(message))
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  }

  async ackInbox(aiId: string, msgIds: string[]): Promise<number> {
    const mailbox = this.inbox.get(aiId);
    if (!mailbox) {
      return 0;
    }

    let acked = 0;
    for (const msgId of msgIds) {
      const current = mailbox.get(msgId);
      if (!current || current.read) {
        continue;
      }

      mailbox.set(msgId, {
        ...current,
        read: true
      });
      acked += 1;
    }
    this.inbox.set(aiId, mailbox);
    return acked;
  }

  clear(): void {
    this.inbox.clear();
    this.sent.clear();
  }
}

let defaultMailboxStore: MailboxStore = new InMemoryMailboxStore();

export function getDefaultMailboxStore(): MailboxStore {
  return defaultMailboxStore;
}

export function setDefaultMailboxStore(store: MailboxStore): void {
  defaultMailboxStore = store;
}

export function clearDefaultMailboxStore(): void {
  defaultMailboxStore.clear();
}

export async function writeInboxMessage(
  aiId: string,
  envelope: Kind17Envelope,
  receivedAt: number,
  deliveredAt: number,
  store: MailboxStore = defaultMailboxStore
): Promise<void> {
  await store.writeInboxMessage(aiId, envelope, receivedAt, deliveredAt);
}

export async function writeSentMessage(
  aiId: string,
  envelope: Kind17Envelope,
  receivedAt: number,
  storedAt: number,
  store: MailboxStore = defaultMailboxStore
): Promise<void> {
  await store.writeSentMessage(aiId, envelope, receivedAt, storedAt);
}

export async function listInboxMessages(
  aiId: string,
  query: InboxQuery,
  store: MailboxStore = defaultMailboxStore
): Promise<InboxQueryResult> {
  return store.listInbox(aiId, query);
}

export async function listSentMessages(
  aiId: string,
  query: SentQuery,
  store: MailboxStore = defaultMailboxStore
): Promise<SentQueryResult> {
  return store.listSent(aiId, query);
}

export async function ackInboxMessages(
  aiId: string,
  msgIds: string[],
  store: MailboxStore = defaultMailboxStore
): Promise<number> {
  return store.ackInbox(aiId, msgIds);
}
