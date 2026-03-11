import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import type { Kind17Envelope } from '../domain/envelope.js';
import {
  InMemoryMailboxStore,
  type InboxQuery,
  type InboxQueryResult,
  type MailboxStore,
  type SentQuery,
  type SentQueryResult
} from './inbox.js';

type MailboxOperation =
  | {
    type: 'write_inbox';
    ai_id: string;
    envelope: Kind17Envelope;
    received_at: number;
    delivered_at: number;
  }
  | {
    type: 'write_sent';
    ai_id: string;
    envelope: Kind17Envelope;
    received_at: number;
    stored_at: number;
  }
  | {
    type: 'ack_inbox';
    ai_id: string;
    msg_ids: string[];
  };

function isStringArrayArray(value: unknown): value is string[][] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'));
}

function isEnvelopeContent(value: unknown): value is Kind17Envelope['content'] {
  if (typeof value === 'string') {
    return true;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isKind17Envelope(value: unknown): value is Kind17Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.id !== 'string'
    || envelope.kind !== 17
    || typeof envelope.ai_id !== 'string'
    || !Number.isInteger(envelope.created_at)
    || !isStringArrayArray(envelope.tags)
    || !isEnvelopeContent(envelope.content)
    || typeof envelope.sig !== 'string'
  ) {
    return false;
  }

  return true;
}

function parseOperationLine(line: string): MailboxOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('invalid_mailbox_log');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid_mailbox_log');
  }

  const operation = parsed as Record<string, unknown>;
  const type = operation.type;
  if (type === 'write_inbox') {
    const receivedAt = operation.received_at;
    const deliveredAt = operation.delivered_at;
    if (
      typeof operation.ai_id === 'string'
      && isKind17Envelope(operation.envelope)
      && typeof receivedAt === 'number'
      && Number.isInteger(receivedAt)
      && typeof deliveredAt === 'number'
      && Number.isInteger(deliveredAt)
    ) {
      return {
        type,
        ai_id: operation.ai_id,
        envelope: operation.envelope,
        received_at: receivedAt,
        delivered_at: deliveredAt
      };
    }
    throw new Error('invalid_mailbox_log');
  }

  if (type === 'write_sent') {
    const receivedAt = operation.received_at;
    const storedAt = operation.stored_at;
    if (
      typeof operation.ai_id === 'string'
      && isKind17Envelope(operation.envelope)
      && typeof receivedAt === 'number'
      && Number.isInteger(receivedAt)
      && typeof storedAt === 'number'
      && Number.isInteger(storedAt)
    ) {
      return {
        type,
        ai_id: operation.ai_id,
        envelope: operation.envelope,
        received_at: receivedAt,
        stored_at: storedAt
      };
    }
    throw new Error('invalid_mailbox_log');
  }

  if (type === 'ack_inbox') {
    if (
      typeof operation.ai_id === 'string'
      && Array.isArray(operation.msg_ids)
      && operation.msg_ids.every((entry) => typeof entry === 'string')
    ) {
      return {
        type,
        ai_id: operation.ai_id,
        msg_ids: operation.msg_ids
      };
    }
    throw new Error('invalid_mailbox_log');
  }

  throw new Error('invalid_mailbox_log');
}

export class FileMailboxStore implements MailboxStore {
  private readonly delegate = new InMemoryMailboxStore();
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.ensureLogPath();
    this.replayLog();
  }

  private ensureLogPath(): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    if (!existsSync(this.logPath)) {
      writeFileSync(this.logPath, '', 'utf8');
    }
  }

  private replayLog(): void {
    const raw = readFileSync(this.logPath, 'utf8');
    if (raw.length === 0) {
      return;
    }

    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    for (const line of lines) {
      const operation = parseOperationLine(line);
      if (operation.type === 'write_inbox') {
        void this.delegate.writeInboxMessage(
          operation.ai_id,
          operation.envelope,
          operation.received_at,
          operation.delivered_at
        );
      } else if (operation.type === 'write_sent') {
        void this.delegate.writeSentMessage(
          operation.ai_id,
          operation.envelope,
          operation.received_at,
          operation.stored_at
        );
      } else {
        void this.delegate.ackInbox(operation.ai_id, operation.msg_ids);
      }
    }
  }

  private appendOperation(operation: MailboxOperation): void {
    appendFileSync(this.logPath, `${JSON.stringify(operation)}\n`, 'utf8');
  }

  async writeInboxMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, deliveredAt: number): Promise<void> {
    await this.delegate.writeInboxMessage(aiId, envelope, receivedAt, deliveredAt);
    this.appendOperation({
      type: 'write_inbox',
      ai_id: aiId,
      envelope,
      received_at: receivedAt,
      delivered_at: deliveredAt
    });
  }

  async writeSentMessage(aiId: string, envelope: Kind17Envelope, receivedAt: number, storedAt: number): Promise<void> {
    await this.delegate.writeSentMessage(aiId, envelope, receivedAt, storedAt);
    this.appendOperation({
      type: 'write_sent',
      ai_id: aiId,
      envelope,
      received_at: receivedAt,
      stored_at: storedAt
    });
  }

  async listInbox(aiId: string, query: InboxQuery): Promise<InboxQueryResult> {
    return this.delegate.listInbox(aiId, query);
  }

  async listSent(aiId: string, query: SentQuery): Promise<SentQueryResult> {
    return this.delegate.listSent(aiId, query);
  }

  async ackInbox(aiId: string, msgIds: string[]): Promise<number> {
    const acked = await this.delegate.ackInbox(aiId, msgIds);
    if (acked > 0) {
      this.appendOperation({
        type: 'ack_inbox',
        ai_id: aiId,
        msg_ids: msgIds
      });
    }
    return acked;
  }

  clear(): void {
    this.delegate.clear();
    writeFileSync(this.logPath, '', 'utf8');
  }
}
