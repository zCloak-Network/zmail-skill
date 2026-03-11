export interface SendSuccessResponse {
  msg_id: string;
  delivered_to: number;
  blocked: string[];
  credits_used: number;
  quota_counted: number;
  idempotent_replay: boolean;
  received_at: number;
}

export interface PendingPublishState {
  deliverable: string[];
  blocked: string[];
  credits_used: number;
  quota_counted: number;
  received_at: number;
  published_inbox_to: string[];
  sent_published: boolean;
}

export type SendIntentStatus = 'pending_publish' | 'completed';

interface SendIntentBase {
  key: string;
  ai_id: string;
  msg_id: string;
  payload_hash: string;
  created_at: number;
  updated_at: number;
}

export type SendIntentRecord =
  | (SendIntentBase & {
    status: 'pending_publish';
    pending_publish: PendingPublishState;
    response?: never;
  })
  | (SendIntentBase & {
    status: 'completed';
    response: SendSuccessResponse;
    pending_publish?: never;
  });

export interface SavePendingSendIntentInput {
  key: string;
  ai_id: string;
  msg_id: string;
  payload_hash: string;
  pending_publish: PendingPublishState;
  nowUnix: number;
}

export interface SaveCompletedSendIntentInput {
  key: string;
  ai_id: string;
  msg_id: string;
  payload_hash: string;
  response: SendSuccessResponse;
  nowUnix: number;
}

export interface SendIntentStore {
  get(key: string): Promise<SendIntentRecord | null>;
  savePendingPublish(input: SavePendingSendIntentInput): Promise<SendIntentRecord>;
  saveCompleted(input: SaveCompletedSendIntentInput): Promise<SendIntentRecord>;
  clear(): void;
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

export class InMemorySendIntentStore implements SendIntentStore {
  private readonly records = new Map<string, SendIntentRecord>();

  async get(key: string): Promise<SendIntentRecord | null> {
    const found = this.records.get(key);
    return found ? cloneRecord(found) : null;
  }

  async savePendingPublish(input: SavePendingSendIntentInput): Promise<SendIntentRecord> {
    const existing = this.records.get(input.key);
    const createdAt = existing?.created_at ?? input.nowUnix;

    const record: SendIntentRecord = {
      key: input.key,
      ai_id: input.ai_id,
      msg_id: input.msg_id,
      payload_hash: input.payload_hash,
      status: 'pending_publish',
      pending_publish: clonePendingPublish(input.pending_publish),
      created_at: createdAt,
      updated_at: input.nowUnix
    };

    this.records.set(input.key, record);
    return cloneRecord(record);
  }

  async saveCompleted(input: SaveCompletedSendIntentInput): Promise<SendIntentRecord> {
    const existing = this.records.get(input.key);
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

    this.records.set(input.key, record);
    return cloneRecord(record);
  }

  clear(): void {
    this.records.clear();
  }
}

let defaultSendIntentStore: SendIntentStore = new InMemorySendIntentStore();

export function getDefaultSendIntentStore(): SendIntentStore {
  return defaultSendIntentStore;
}

export function setDefaultSendIntentStore(store: SendIntentStore): void {
  defaultSendIntentStore = store;
}

export function clearDefaultSendIntentStore(): void {
  defaultSendIntentStore.clear();
}

export async function getSendIntent(key: string, store: SendIntentStore = defaultSendIntentStore): Promise<SendIntentRecord | null> {
  return store.get(key);
}

export async function savePendingSendIntent(
  input: SavePendingSendIntentInput,
  store: SendIntentStore = defaultSendIntentStore
): Promise<SendIntentRecord> {
  return store.savePendingPublish(input);
}

export async function saveCompletedSendIntent(
  input: SaveCompletedSendIntentInput,
  store: SendIntentStore = defaultSendIntentStore
): Promise<SendIntentRecord> {
  return store.saveCompleted(input);
}
