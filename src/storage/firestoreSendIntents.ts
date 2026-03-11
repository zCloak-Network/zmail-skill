import type { FirestoreLike } from './firestoreMailbox.js';
import type {
  PendingPublishState,
  SaveCompletedSendIntentInput,
  SavePendingSendIntentInput,
  SendIntentRecord,
  SendIntentStore,
  SendSuccessResponse
} from './sendIntents.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneResponse(response: SendSuccessResponse): SendSuccessResponse {
  return {
    msg_id: response.msg_id,
    delivered_to: response.delivered_to,
    blocked: [...response.blocked],
    credits_used: response.credits_used,
    quota_counted: response.quota_counted,
    idempotent_replay: response.idempotent_replay,
    received_at: response.received_at
  };
}

function clonePendingPublish(state: PendingPublishState): PendingPublishState {
  return {
    deliverable: [...state.deliverable],
    blocked: [...state.blocked],
    credits_used: state.credits_used,
    quota_counted: state.quota_counted,
    received_at: state.received_at,
    published_inbox_to: [...state.published_inbox_to],
    sent_published: state.sent_published
  };
}

function mergePendingPublish(existing: PendingPublishState | null, incoming: PendingPublishState): PendingPublishState {
  if (existing === null) {
    return clonePendingPublish(incoming);
  }

  const mergedPublishedInboxTo = [...new Set([...existing.published_inbox_to, ...incoming.published_inbox_to])];
  return {
    deliverable: [...incoming.deliverable],
    blocked: [...incoming.blocked],
    credits_used: incoming.credits_used,
    quota_counted: incoming.quota_counted,
    received_at: incoming.received_at,
    published_inbox_to: mergedPublishedInboxTo,
    sent_published: existing.sent_published || incoming.sent_published
  };
}

function cloneRecord(record: SendIntentRecord): SendIntentRecord {
  if (record.status === 'completed') {
    return {
      key: record.key,
      ai_id: record.ai_id,
      msg_id: record.msg_id,
      payload_hash: record.payload_hash,
      status: 'completed',
      response: cloneResponse(record.response),
      created_at: record.created_at,
      updated_at: record.updated_at
    };
  }

  return {
    key: record.key,
    ai_id: record.ai_id,
    msg_id: record.msg_id,
    payload_hash: record.payload_hash,
    status: 'pending_publish',
    pending_publish: clonePendingPublish(record.pending_publish),
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return [...value] as string[];
}

function parseResponse(value: unknown): SendSuccessResponse | null {
  if (!isObject(value)) {
    return null;
  }
  const msgId = value.msg_id;
  const deliveredTo = value.delivered_to;
  const blocked = parseStringArray(value.blocked);
  const creditsUsed = value.credits_used;
  const quotaCounted = value.quota_counted;
  const idempotentReplay = value.idempotent_replay;
  const receivedAt = value.received_at;

  if (
    typeof msgId !== 'string'
    || typeof deliveredTo !== 'number'
    || !Number.isInteger(deliveredTo)
    || blocked === null
    || typeof creditsUsed !== 'number'
    || !Number.isInteger(creditsUsed)
    || typeof quotaCounted !== 'number'
    || !Number.isInteger(quotaCounted)
    || typeof idempotentReplay !== 'boolean'
    || typeof receivedAt !== 'number'
    || !Number.isInteger(receivedAt)
  ) {
    return null;
  }

  return {
    msg_id: msgId,
    delivered_to: deliveredTo,
    blocked,
    credits_used: creditsUsed,
    quota_counted: quotaCounted,
    idempotent_replay: idempotentReplay,
    received_at: receivedAt
  };
}

function parsePendingPublish(value: unknown): PendingPublishState | null {
  if (!isObject(value)) {
    return null;
  }

  const deliverable = parseStringArray(value.deliverable);
  const blocked = parseStringArray(value.blocked);
  const publishedInboxTo = parseStringArray(value.published_inbox_to);
  const creditsUsed = value.credits_used;
  const quotaCounted = value.quota_counted;
  const receivedAt = value.received_at;
  const sentPublished = value.sent_published;

  if (
    deliverable === null
    || blocked === null
    || publishedInboxTo === null
    || typeof creditsUsed !== 'number'
    || !Number.isInteger(creditsUsed)
    || typeof quotaCounted !== 'number'
    || !Number.isInteger(quotaCounted)
    || typeof receivedAt !== 'number'
    || !Number.isInteger(receivedAt)
    || typeof sentPublished !== 'boolean'
  ) {
    return null;
  }

  return {
    deliverable,
    blocked,
    credits_used: creditsUsed,
    quota_counted: quotaCounted,
    received_at: receivedAt,
    published_inbox_to: publishedInboxTo,
    sent_published: sentPublished
  };
}

function parseRecord(docId: string, value: unknown): SendIntentRecord | null {
  if (!isObject(value)) {
    return null;
  }

  const key = value.key;
  const aiId = value.ai_id;
  const msgId = value.msg_id;
  const payloadHash = value.payload_hash;
  const status = value.status;
  const createdAt = value.created_at;
  const updatedAt = value.updated_at;

  if (
    typeof key !== 'string'
    || key !== docId
    || typeof aiId !== 'string'
    || typeof msgId !== 'string'
    || typeof payloadHash !== 'string'
    || typeof createdAt !== 'number'
    || !Number.isInteger(createdAt)
    || typeof updatedAt !== 'number'
    || !Number.isInteger(updatedAt)
  ) {
    return null;
  }

  if (status === 'completed') {
    const response = parseResponse(value.response);
    if (response === null) {
      return null;
    }
    return {
      key,
      ai_id: aiId,
      msg_id: msgId,
      payload_hash: payloadHash,
      status: 'completed',
      response,
      created_at: createdAt,
      updated_at: updatedAt
    };
  }

  if (status === 'pending_publish') {
    const pendingPublish = parsePendingPublish(value.pending_publish);
    if (pendingPublish === null) {
      return null;
    }
    return {
      key,
      ai_id: aiId,
      msg_id: msgId,
      payload_hash: payloadHash,
      status: 'pending_publish',
      pending_publish: pendingPublish,
      created_at: createdAt,
      updated_at: updatedAt
    };
  }

  return null;
}

function toFirestoreRecord(record: SendIntentRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: record.key,
    ai_id: record.ai_id,
    msg_id: record.msg_id,
    payload_hash: record.payload_hash,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at
  };

  if (record.status === 'completed') {
    out.response = cloneResponse(record.response);
  } else {
    out.pending_publish = clonePendingPublish(record.pending_publish);
  }

  return out;
}

export class FirestoreSendIntentStore implements SendIntentStore {
  constructor(private readonly db: FirestoreLike) {}

  private docRef(key: string) {
    return this.db.collection('send_intents').doc(key);
  }

  async get(key: string): Promise<SendIntentRecord | null> {
    const snapshot = await this.docRef(key).get();
    if (!snapshot.exists) {
      return null;
    }
    const parsed = parseRecord(snapshot.id, snapshot.data());
    return parsed ? cloneRecord(parsed) : null;
  }

  async savePendingPublish(input: SavePendingSendIntentInput): Promise<SendIntentRecord> {
    const docRef = this.docRef(input.key);
    const runTransaction = this.db.runTransaction?.bind(this.db);
    if (typeof runTransaction === 'function') {
      const record = await runTransaction(async (tx) => {
        const existingSnapshot = await tx.get(docRef);
        const existing = existingSnapshot.exists
          ? parseRecord(existingSnapshot.id, existingSnapshot.data())
          : null;

        if (existing?.status === 'completed') {
          return existing;
        }

        const createdAt = existing?.created_at ?? input.nowUnix;
        const existingPending = existing?.status === 'pending_publish' ? existing.pending_publish : null;
        const nextRecord: SendIntentRecord = {
          key: input.key,
          ai_id: input.ai_id,
          msg_id: input.msg_id,
          payload_hash: input.payload_hash,
          status: 'pending_publish',
          pending_publish: mergePendingPublish(existingPending, input.pending_publish),
          created_at: createdAt,
          updated_at: input.nowUnix
        };

        tx.set(docRef, toFirestoreRecord(nextRecord));
        return nextRecord;
      });
      return cloneRecord(record);
    }

    const existingSnapshot = await docRef.get();
    const existing = existingSnapshot.exists
      ? parseRecord(existingSnapshot.id, existingSnapshot.data())
      : null;
    if (existing?.status === 'completed') {
      return cloneRecord(existing);
    }

    const createdAt = existing?.created_at ?? input.nowUnix;
    const existingPending = existing?.status === 'pending_publish' ? existing.pending_publish : null;
    const record: SendIntentRecord = {
      key: input.key,
      ai_id: input.ai_id,
      msg_id: input.msg_id,
      payload_hash: input.payload_hash,
      status: 'pending_publish',
      pending_publish: mergePendingPublish(existingPending, input.pending_publish),
      created_at: createdAt,
      updated_at: input.nowUnix
    };

    await docRef.set(toFirestoreRecord(record));
    return cloneRecord(record);
  }

  async saveCompleted(input: SaveCompletedSendIntentInput): Promise<SendIntentRecord> {
    const docRef = this.docRef(input.key);
    const runTransaction = this.db.runTransaction?.bind(this.db);
    if (typeof runTransaction === 'function') {
      const record = await runTransaction(async (tx) => {
        const existingSnapshot = await tx.get(docRef);
        const existing = existingSnapshot.exists
          ? parseRecord(existingSnapshot.id, existingSnapshot.data())
          : null;

        if (existing?.status === 'completed') {
          return existing;
        }

        const createdAt = existing?.created_at ?? input.nowUnix;
        const nextRecord: SendIntentRecord = {
          key: input.key,
          ai_id: input.ai_id,
          msg_id: input.msg_id,
          payload_hash: input.payload_hash,
          status: 'completed',
          response: cloneResponse(input.response),
          created_at: createdAt,
          updated_at: input.nowUnix
        };

        tx.set(docRef, toFirestoreRecord(nextRecord));
        return nextRecord;
      });
      return cloneRecord(record);
    }

    const existingSnapshot = await docRef.get();
    const existing = existingSnapshot.exists
      ? parseRecord(existingSnapshot.id, existingSnapshot.data())
      : null;
    if (existing?.status === 'completed') {
      return cloneRecord(existing);
    }

    const createdAt = existing?.created_at ?? input.nowUnix;
    const record: SendIntentRecord = {
      key: input.key,
      ai_id: input.ai_id,
      msg_id: input.msg_id,
      payload_hash: input.payload_hash,
      status: 'completed',
      response: cloneResponse(input.response),
      created_at: createdAt,
      updated_at: input.nowUnix
    };

    await docRef.set(toFirestoreRecord(record));
    return cloneRecord(record);
  }

  clear(): void {
    // Firestore-backed clear is intentionally a no-op to keep the contract synchronous.
  }
}
