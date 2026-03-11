import type { Kind17Envelope } from '../domain/envelope.js';
import { extractRecipients } from '../domain/recipients.js';
import { FieldValue } from '@google-cloud/firestore';
import type {
  InboxQuery,
  InboxQueryResult,
  MailboxStore,
  SentQuery,
  SentQueryResult,
  StoredInboxMessage,
  StoredSentMessage
} from './inbox.js';

export type FirestoreWhereOperator = '<' | '<=' | '==' | '>' | '>=' | 'array-contains';

export interface FirestoreDocSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FirestoreQuerySnapshotLike {
  readonly docs: FirestoreDocSnapshotLike[];
}

export interface FirestoreDocumentReferenceLike {
  get(): Promise<FirestoreDocSnapshotLike>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
}

export interface FirestoreTransactionLike {
  get(docRef: FirestoreDocumentReferenceLike): Promise<FirestoreDocSnapshotLike>;
  set(docRef: FirestoreDocumentReferenceLike, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  update(docRef: FirestoreDocumentReferenceLike, data: Record<string, unknown>): void;
}

export interface FirestoreQueryLike {
  where(fieldPath: string, opStr: FirestoreWhereOperator, value: unknown): FirestoreQueryLike;
  orderBy(fieldPath: string, directionStr?: 'asc' | 'desc'): FirestoreQueryLike;
  limit(limit: number): FirestoreQueryLike;
  startAfter(...fieldValues: unknown[]): FirestoreQueryLike;
  get(): Promise<FirestoreQuerySnapshotLike>;
}

export interface FirestoreCollectionReferenceLike extends FirestoreQueryLike {
  doc(id: string): FirestoreDocumentReferenceLike;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionReferenceLike;
  runTransaction?<T>(updateFunction: (transaction: FirestoreTransactionLike) => Promise<T>): Promise<T>;
}

interface CursorPayloadV1 {
  v: 1;
  r: number;
  i: string;
}

interface StatsDelta {
  unread_count?: number;
  total_received?: number;
  total_sent?: number;
}

type DeliveryMarkerType = 'inbox' | 'sent';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return 20;
  }
  return Math.min(limit, 100);
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
    !isObject(parsed)
    || parsed.v !== 1
    || typeof parsed.i !== 'string'
    || parsed.i.length === 0
    || typeof parsed.r !== 'number'
    || !Number.isInteger(parsed.r)
  ) {
    throw new Error('invalid_cursor');
  }

  return {
    v: 1,
    r: parsed.r,
    i: parsed.i
  };
}

function cloneTags(tags: Kind17Envelope['tags']): Kind17Envelope['tags'] {
  return tags.map((tag) => [...tag]) as Kind17Envelope['tags'];
}

function cloneContent(content: Kind17Envelope['content']): Kind17Envelope['content'] {
  if (typeof content === 'string') {
    return content;
  }
  return { ...content };
}

function encodeTags(tags: Kind17Envelope['tags']): string {
  return JSON.stringify(cloneTags(tags));
}

function toEnvelopeRecord(envelope: Kind17Envelope): Record<string, unknown> {
  return {
    id: envelope.id,
    kind: envelope.kind,
    ai_id: envelope.ai_id,
    created_at: envelope.created_at,
    tags: encodeTags(envelope.tags),
    content: cloneContent(envelope.content),
    sig: envelope.sig
  };
}

function parseTags(value: unknown): Kind17Envelope['tags'] | null {
  if (typeof value === 'string') {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(value);
    } catch {
      return null;
    }
    return parseTags(parsedJson);
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parsed: string[][] = [];
  for (const tag of value) {
    if (!Array.isArray(tag) || tag.some((entry) => typeof entry !== 'string')) {
      return null;
    }
    parsed.push([...tag]);
  }
  return parsed as Kind17Envelope['tags'];
}

function parseContent(value: unknown): Kind17Envelope['content'] | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!isObject(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      return null;
    }
    out[key] = entry;
  }
  return out;
}

function parseEnvelope(docId: string, data: Record<string, unknown>): Kind17Envelope | null {
  const kind = data.kind;
  const aiId = data.ai_id;
  const createdAt = data.created_at;
  const tags = parseTags(data.tags);
  const content = parseContent(data.content);
  const sig = data.sig;
  if (
    kind !== 17
    || typeof aiId !== 'string'
    || typeof createdAt !== 'number'
    || !Number.isInteger(createdAt)
    || tags === null
    || content === null
    || typeof sig !== 'string'
  ) {
    return null;
  }

  return {
    id: docId,
    kind: 17,
    ai_id: aiId,
    created_at: createdAt,
    tags,
    content,
    sig
  };
}

function parseStoredInboxMessage(snapshot: FirestoreDocSnapshotLike): StoredInboxMessage | null {
  const data = snapshot.data();
  if (!data) {
    return null;
  }
  const envelope = parseEnvelope(snapshot.id, data);
  const receivedAt = data.received_at;
  const deliveredAt = data.delivered_at;
  if (envelope === null || typeof receivedAt !== 'number' || typeof deliveredAt !== 'number') {
    return null;
  }

  return {
    ...envelope,
    read: data.read === true,
    received_at: receivedAt,
    delivered_at: deliveredAt
  };
}

function parseStoredSentMessage(snapshot: FirestoreDocSnapshotLike): StoredSentMessage | null {
  const data = snapshot.data();
  if (!data) {
    return null;
  }
  const envelope = parseEnvelope(snapshot.id, data);
  const receivedAt = data.received_at;
  const storedAt = data.stored_at;
  const recipientsValue = data.recipients;
  if (
    envelope === null
    || typeof receivedAt !== 'number'
    || typeof storedAt !== 'number'
    || !Array.isArray(recipientsValue)
    || recipientsValue.some((entry) => typeof entry !== 'string')
  ) {
    return null;
  }

  return {
    ...envelope,
    received_at: receivedAt,
    stored_at: storedAt,
    recipients: [...recipientsValue] as string[]
  };
}

function cloneInboxMessage(message: StoredInboxMessage): StoredInboxMessage {
  return {
    id: message.id,
    kind: message.kind,
    ai_id: message.ai_id,
    created_at: message.created_at,
    tags: cloneTags(message.tags),
    content: cloneContent(message.content),
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
    tags: cloneTags(message.tags),
    content: cloneContent(message.content),
    sig: message.sig,
    received_at: message.received_at,
    stored_at: message.stored_at,
    recipients: [...message.recipients]
  };
}

function buildStatsIncrementPatch(delta: StatsDelta): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof delta.unread_count === 'number' && delta.unread_count !== 0) {
    patch.unread_count = FieldValue.increment(delta.unread_count);
  }
  if (typeof delta.total_received === 'number' && delta.total_received !== 0) {
    patch.total_received = FieldValue.increment(delta.total_received);
  }
  if (typeof delta.total_sent === 'number' && delta.total_sent !== 0) {
    patch.total_sent = FieldValue.increment(delta.total_sent);
  }
  return patch;
}

function parseUnreadCount(data: Record<string, unknown> | undefined): number {
  if (!data || typeof data.unread_count !== 'number' || !Number.isFinite(data.unread_count)) {
    return 0;
  }
  return Math.max(0, Math.floor(data.unread_count));
}

export class FirestoreMailboxStore implements MailboxStore {
  constructor(private readonly db: FirestoreLike) {}

  private inboxCollection(aiId: string): FirestoreCollectionReferenceLike {
    return this.db.collection(`agents/${aiId}/inbox`);
  }

  private sentCollection(aiId: string): FirestoreCollectionReferenceLike {
    return this.db.collection(`agents/${aiId}/sent`);
  }

  private statsDoc(aiId: string): FirestoreDocumentReferenceLike {
    return this.db.collection(`agents/${aiId}/meta`).doc('stats');
  }

  private deliveryMarkerDoc(aiId: string, mailboxType: DeliveryMarkerType, msgId: string): FirestoreDocumentReferenceLike {
    return this.db.collection(`agents/${aiId}/delivery_markers`).doc(`${mailboxType}:${msgId}`);
  }

  private async incrementStats(aiId: string, delta: StatsDelta): Promise<void> {
    const patch = buildStatsIncrementPatch(delta);
    if (Object.keys(patch).length === 0) {
      return;
    }
    await this.statsDoc(aiId).set(patch, { merge: true });
  }

  private async writeMailboxWithDeliveryMarker(input: {
    aiId: string;
    msgId: string;
    mailboxType: DeliveryMarkerType;
    messageDocRef: FirestoreDocumentReferenceLike;
    messagePayload: Record<string, unknown>;
    markerCreatedAt: number;
    statsDelta: StatsDelta;
  }): Promise<void> {
    const markerRef = this.deliveryMarkerDoc(input.aiId, input.mailboxType, input.msgId);
    const statsRef = this.statsDoc(input.aiId);
    const statsPatch = buildStatsIncrementPatch(input.statsDelta);

    if (typeof this.db.runTransaction === 'function') {
      await this.db.runTransaction(async (tx) => {
        const markerSnapshot = await tx.get(markerRef);
        if (markerSnapshot.exists) {
          return;
        }

        const messageSnapshot = await tx.get(input.messageDocRef);
        if (!messageSnapshot.exists) {
          tx.set(input.messageDocRef, input.messagePayload);
        }

        if (Object.keys(statsPatch).length > 0) {
          tx.set(statsRef, statsPatch, { merge: true });
        }
        tx.set(markerRef, {
          msg_id: input.msgId,
          mailbox_type: input.mailboxType,
          created_at: input.markerCreatedAt
        });
      });
      return;
    }

    const markerSnapshot = await markerRef.get();
    if (markerSnapshot.exists) {
      return;
    }

    const messageSnapshot = await input.messageDocRef.get();
    if (!messageSnapshot.exists) {
      await input.messageDocRef.set(input.messagePayload);
    }

    // Best-effort fallback if transaction support is unavailable on the DB adapter.
    await markerRef.set({
      msg_id: input.msgId,
      mailbox_type: input.mailboxType,
      created_at: input.markerCreatedAt
    });
    await this.incrementStats(input.aiId, input.statsDelta);
  }

  async writeInboxMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, deliveredAt: number): Promise<void> {
    const docRef = this.inboxCollection(aiId).doc(envelope.id);
    await this.writeMailboxWithDeliveryMarker({
      aiId,
      msgId: envelope.id,
      mailboxType: 'inbox',
      messageDocRef: docRef,
      messagePayload: {
        ...toEnvelopeRecord(envelope),
        read: false,
        received_at: receivedAt,
        delivered_at: deliveredAt
      },
      markerCreatedAt: deliveredAt,
      statsDelta: { unread_count: 1, total_received: 1 }
    });
  }

  async writeSentMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, storedAt: number): Promise<void> {
    const docRef = this.sentCollection(aiId).doc(envelope.id);
    await this.writeMailboxWithDeliveryMarker({
      aiId,
      msgId: envelope.id,
      mailboxType: 'sent',
      messageDocRef: docRef,
      messagePayload: {
        ...toEnvelopeRecord(envelope),
        received_at: receivedAt,
        stored_at: storedAt,
        recipients: extractRecipients(envelope.tags)
      },
      markerCreatedAt: storedAt,
      statsDelta: { total_sent: 1 }
    });
  }

  async listInbox(aiId: string, query: InboxQuery): Promise<InboxQueryResult> {
    const limit = normalizeLimit(query.limit);
    let fsQuery: FirestoreQueryLike = this.inboxCollection(aiId);
    if (query.unread === true) {
      fsQuery = fsQuery.where('read', '==', false);
    }
    if (query.from) {
      fsQuery = fsQuery.where('ai_id', '==', query.from);
    }
    fsQuery = fsQuery.orderBy('received_at', 'desc').orderBy('id', 'desc');

    if (query.after) {
      const cursor = decodeCursor(query.after);
      fsQuery = fsQuery.startAfter(cursor.r, cursor.i);
    }

    const [snapshot, statsSnapshot] = await Promise.all([
      fsQuery.limit(limit + 1).get(),
      this.statsDoc(aiId).get()
    ]);
    const hasMore = snapshot.docs.length > limit;
    const pageDocs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
    const messages = pageDocs
      .map((snapshotDoc) => parseStoredInboxMessage(snapshotDoc))
      .filter((message): message is StoredInboxMessage => message !== null)
      .map((message) => cloneInboxMessage(message));
    const unreadCount = parseUnreadCount(statsSnapshot.data());

    let cursor: string | undefined;
    if (hasMore) {
      const last = messages[messages.length - 1];
      if (last) {
        cursor = encodeCursor(last.received_at, last.id);
      }
    }

    const result: InboxQueryResult = {
      messages,
      unread_count: unreadCount
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  }

  async listSent(aiId: string, query: SentQuery): Promise<SentQueryResult> {
    const limit = normalizeLimit(query.limit);
    let fsQuery: FirestoreQueryLike = this.sentCollection(aiId);
    if (query.to) {
      fsQuery = fsQuery.where('recipients', 'array-contains', query.to);
    }
    fsQuery = fsQuery.orderBy('received_at', 'desc').orderBy('id', 'desc');

    if (query.after) {
      const cursor = decodeCursor(query.after);
      fsQuery = fsQuery.startAfter(cursor.r, cursor.i);
    }

    const snapshot = await fsQuery.limit(limit + 1).get();
    const hasMore = snapshot.docs.length > limit;
    const pageDocs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
    const messages = pageDocs
      .map((snapshotDoc) => parseStoredSentMessage(snapshotDoc))
      .filter((message): message is StoredSentMessage => message !== null)
      .map((message) => cloneSentMessage(message));

    let cursor: string | undefined;
    if (hasMore) {
      const last = messages[messages.length - 1];
      if (last) {
        cursor = encodeCursor(last.received_at, last.id);
      }
    }

    const result: SentQueryResult = {
      messages
    };
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  }

  async ackInbox(aiId: string, msgIds: string[]): Promise<number> {
    const uniqueIds = [...new Set(msgIds)];
    let acked = 0;
    const statsRef = this.statsDoc(aiId);

    for (const msgId of uniqueIds) {
      const docRef = this.inboxCollection(aiId).doc(msgId);
      if (typeof this.db.runTransaction === 'function') {
        const didAck = await this.db.runTransaction(async (tx) => {
          const snapshot = await tx.get(docRef);
          const message = parseStoredInboxMessage(snapshot);
          if (!message || message.read) {
            return false;
          }
          tx.update(docRef, { read: true });
          tx.set(statsRef, { unread_count: FieldValue.increment(-1) }, { merge: true });
          return true;
        });
        if (didAck) {
          acked += 1;
        }
        continue;
      }

      const snapshot = await docRef.get();
      const message = parseStoredInboxMessage(snapshot);
      if (!message || message.read) {
        continue;
      }
      await docRef.update({ read: true });
      acked += 1;
    }

    if (acked > 0 && typeof this.db.runTransaction !== 'function') {
      await this.incrementStats(aiId, { unread_count: -acked });
    }
    return acked;
  }

  clear(): void {
    // Firestore-backed clear is intentionally a no-op to keep the contract synchronous.
  }
}
