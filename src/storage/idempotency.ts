import { createHash } from 'node:crypto';
import type { PendingPublishState, SendIntentRecord, SendSuccessResponse } from './sendIntents.js';

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => compareStrings(left, right));
    for (const [key, nested] of entries) {
      out[normalizeText(key)] = canonicalize(nested);
    }
    return out;
  }

  return value;
}

export function computePayloadHash(payload: unknown): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export type IdempotencyDecision =
  | { type: 'new'; payloadHash: string }
  | { type: 'conflict' }
  | { type: 'replay'; response: SendSuccessResponse }
  | { type: 'pending'; state: PendingPublishState };

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

export function replayIdempotentResponse(existingIntent: SendIntentRecord | null, payloadHash: string): IdempotencyDecision {
  if (!existingIntent) {
    return { type: 'new', payloadHash };
  }

  if (existingIntent.payload_hash !== payloadHash) {
    return { type: 'conflict' };
  }

  if (existingIntent.status === 'pending_publish') {
    return {
      type: 'pending',
      state: clonePendingPublish(existingIntent.pending_publish)
    };
  }

  const replayResponse: SendSuccessResponse = {
    msg_id: existingIntent.response.msg_id,
    delivered_to: existingIntent.response.delivered_to,
    blocked: [...existingIntent.response.blocked],
    credits_used: existingIntent.response.credits_used,
    quota_counted: existingIntent.response.quota_counted,
    idempotent_replay: true,
    received_at: existingIntent.response.received_at
  };

  return {
    type: 'replay',
    response: replayResponse
  };
}
