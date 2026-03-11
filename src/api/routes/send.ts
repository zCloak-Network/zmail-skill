import { resolveCachedAgent } from '../middleware/auth.js';
import type { Kind17Envelope } from '../../domain/envelope.js';
import { extractRecipients } from '../../domain/recipients.js';
import { validateEnvelope } from '../../domain/validation.js';
import {
  deductCredits,
  CreditApiUnavailableError,
  InsufficientCreditsError
} from '../../external/credits.js';
import { checkOwnerBinding, OwnerBindingUnavailableError } from '../../external/ownerBinding.js';
import { publishEnvelope } from '../../pubsub/publisher.js';
import { computePayloadHash, replayIdempotentResponse } from '../../storage/idempotency.js';
import {
  commitRateLimitState,
  previewRateLimitDecision,
  rollbackRateLimitState,
  updateRateLimitState
} from '../../storage/ratelimit.js';
import {
  getSendIntent,
  savePendingSendIntent,
  saveCompletedSendIntent,
  type SaveCompletedSendIntentInput,
  type SavePendingSendIntentInput,
  type PendingPublishState,
  type SendIntentRecord,
  type SendSuccessResponse
} from '../../storage/sendIntents.js';
import { isSenderBlockedByRecipient } from '../../storage/agents.js';

export interface SendRequest {
  body: unknown;
}

export type SendErrorCode =
  | 'invalid_schema'
  | 'message_too_large'
  | 'invalid_id'
  | 'invalid_sig'
  | 'too_many_recipients'
  | 'clock_ahead'
  | 'clock_behind'
  | 'unknown_sender'
  | 'insufficient_credits'
  | 'agent_not_bound'
  | 'all_recipients_blocked'
  | 'recipient_not_found'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'internal_error';

export interface SendErrorBody {
  error: SendErrorCode;
  principal?: string;
  principals?: string[];
  credits_needed?: number;
  retry_after?: number;
}

export type SendResponse =
  | { status: 200; body: SendSuccessResponse }
  | { status: 400; body: SendErrorBody }
  | { status: 401; body: SendErrorBody }
  | { status: 402; body: SendErrorBody }
  | { status: 403; body: SendErrorBody }
  | { status: 404; body: SendErrorBody }
  | { status: 409; body: SendErrorBody }
  | { status: 429; body: SendErrorBody }
  | { status: 500; body: SendErrorBody };

export interface SendAccountingInput {
  aiId: string;
  msgId: string;
  deliverableCount: number;
  nowUnix: number;
}

export type SendAccountingDecision =
  | { ok: true; creditsUsed: number; quotaCounted: number }
  | { ok: false; error: 'insufficient_credits'; creditsNeeded: number }
  | { ok: false; error: 'rate_limited'; retryAfter: number }
  | { ok: false; error: 'internal_error' };

export interface SendDependencies {
  nowUnix?: () => number;
  ownerBindingCheck?: (aiId: string) => Promise<{ bound: boolean }>;
  isBlocked?: (recipientAiId: string, senderAiId: string) => Promise<boolean>;
  getSendIntentFn?: (key: string) => Promise<SendIntentRecord | null>;
  savePendingSendIntentFn?: (input: SavePendingSendIntentInput) => Promise<SendIntentRecord>;
  saveCompletedSendIntentFn?: (input: SaveCompletedSendIntentInput) => Promise<SendIntentRecord>;
  publishEnvelopeFn?: typeof publishEnvelope;
  accountingFn?: (input: SendAccountingInput) => Promise<SendAccountingDecision>;
  updateRateLimitStateFn?: typeof updateRateLimitState;
  rollbackRateLimitStateFn?: typeof rollbackRateLimitState;
  previewRateLimitDecisionFn?: typeof previewRateLimitDecision;
  commitRateLimitStateFn?: typeof commitRateLimitState;
  deductCreditsFn?: typeof deductCredits;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function buildRecipientNotFound(principal: string): SendResponse {
  return {
    status: 404,
    body: {
      error: 'recipient_not_found',
      principal
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRateLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (
    code === 4
    || code === 10
    || code === 14
    || code === 'ABORTED'
    || code === 'DEADLINE_EXCEEDED'
    || code === 'UNAVAILABLE'
    || code === 'aborted'
    || code === 'deadline_exceeded'
    || code === 'unavailable'
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('aborted')
    || message.includes('contention')
    || message.includes('deadline')
    || message.includes('temporarily unavailable');
}

async function defaultAccounting(
  input: SendAccountingInput,
  dependencies: SendDependencies
): Promise<SendAccountingDecision> {
  const updateRateLimitStateFn = dependencies.updateRateLimitStateFn ?? updateRateLimitState;
  const rollbackRateLimitStateFn = dependencies.rollbackRateLimitStateFn ?? rollbackRateLimitState;
  const previewRateLimitDecisionFn = dependencies.previewRateLimitDecisionFn ?? previewRateLimitDecision;
  const commitRateLimitStateFn = dependencies.commitRateLimitStateFn ?? commitRateLimitState;
  const deductCreditsFn = dependencies.deductCreditsFn ?? deductCredits;
  const useLegacyPreviewCommit = Boolean(dependencies.previewRateLimitDecisionFn || dependencies.commitRateLimitStateFn);

  const maxRateLimitAttempts = useLegacyPreviewCommit ? 1 : 3;
  let rateLimitDecision;
  for (let attempt = 1; attempt <= maxRateLimitAttempts; attempt += 1) {
    try {
      rateLimitDecision = useLegacyPreviewCommit
        ? await previewRateLimitDecisionFn(input.aiId, input.deliverableCount, input.nowUnix)
        : await updateRateLimitStateFn(input.aiId, input.deliverableCount, input.nowUnix);
      break;
    } catch (error) {
      const shouldRetry = !useLegacyPreviewCommit
        && attempt < maxRateLimitAttempts
        && isRetryableRateLimitError(error);
      if (!shouldRetry) {
        throw error;
      }
      // Brief backoff smooths same-agent transaction contention spikes.
      await sleep(20 * attempt);
    }
  }

  if (!rateLimitDecision) {
    throw new Error('rate_limit_decision_unavailable');
  }
  if (!rateLimitDecision.allowed) {
    return {
      ok: false,
      error: 'rate_limited',
      retryAfter: rateLimitDecision.retry_after ?? 30
    };
  }

  const creditsNeeded = rateLimitDecision.credits_needed;
  if (creditsNeeded > 0) {
    try {
      await deductCreditsFn(input.aiId, creditsNeeded, `${input.aiId}:${input.msgId}`);
    } catch (error) {
      if (!useLegacyPreviewCommit) {
        try {
          await rollbackRateLimitStateFn(input.aiId, input.deliverableCount, input.nowUnix);
        } catch {
          return { ok: false, error: 'internal_error' };
        }
      }
      if (error instanceof InsufficientCreditsError) {
        return {
          ok: false,
          error: 'insufficient_credits',
          creditsNeeded: error.creditsNeeded
        };
      }
      if (error instanceof CreditApiUnavailableError) {
        return { ok: false, error: 'internal_error' };
      }
      return { ok: false, error: 'internal_error' };
    }
  }

  if (useLegacyPreviewCommit) {
    await commitRateLimitStateFn(input.aiId, rateLimitDecision.next_state);
  }

  return {
    ok: true,
    creditsUsed: creditsNeeded,
    quotaCounted: rateLimitDecision.quota_counted
  };
}

export async function handleSend(request: SendRequest, dependencies: SendDependencies = {}): Promise<SendResponse> {
  if (!isObject(request.body)) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const aiId = request.body.ai_id;
  if (!isNonEmptyString(aiId)) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const nowUnix = dependencies.nowUnix ?? (() => Math.floor(Date.now() / 1000));
  const receivedAt = nowUnix();

  const sender = await resolveCachedAgent(aiId, { nowUnix: receivedAt });
  if (!sender) {
    return { status: 401, body: { error: 'unknown_sender' } };
  }

  const envelope = request.body as unknown as Kind17Envelope;
  const validation = validateEnvelope(envelope, {
    receivedAtUnix: receivedAt,
    senderPubkeyHex: sender.schnorr_pubkey
  });
  if (!validation.ok) {
    return { status: 400, body: { error: validation.error ?? 'invalid_schema' } };
  }

  let recipients: string[];
  try {
    recipients = extractRecipients(envelope.tags);
  } catch {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const ownerBindingCheck = dependencies.ownerBindingCheck ?? checkOwnerBinding;
  let ownerBinding: { bound: boolean };
  try {
    ownerBinding = await ownerBindingCheck(aiId);
  } catch (error) {
    if (error instanceof OwnerBindingUnavailableError) {
      return { status: 500, body: { error: 'internal_error' } };
    }
    return { status: 500, body: { error: 'internal_error' } };
  }
  if (!ownerBinding.bound) {
    return { status: 403, body: { error: 'agent_not_bound' } };
  }

  for (const recipient of recipients) {
    if (!await resolveCachedAgent(recipient, { nowUnix: receivedAt })) {
      return buildRecipientNotFound(recipient);
    }
  }

  const isBlocked = dependencies.isBlocked ?? isSenderBlockedByRecipient;
  const deliverable: string[] = [];
  const blocked: string[] = [];
  for (const recipient of recipients) {
    if (await isBlocked(recipient, aiId)) {
      blocked.push(recipient);
    } else {
      deliverable.push(recipient);
    }
  }

  if (deliverable.length === 0) {
    return {
      status: 403,
      body: {
        error: 'all_recipients_blocked',
        principals: blocked
      }
    };
  }

  const msgId = envelope.id;
  const sendIntentKey = `${aiId}:${msgId}`;
  const senderSchnorrPubkey = sender.schnorr_pubkey;

  const payloadHash = computePayloadHash(envelope);
  const getSendIntentFn = dependencies.getSendIntentFn ?? getSendIntent;
  const existingIntent = await getSendIntentFn(sendIntentKey);
  const idempotencyDecision = replayIdempotentResponse(existingIntent, payloadHash);

  if (idempotencyDecision.type === 'conflict') {
    return { status: 409, body: { error: 'idempotency_conflict' } };
  }

  if (idempotencyDecision.type === 'replay') {
    return {
      status: 200,
      body: idempotencyDecision.response
    };
  }

  const savePendingSendIntentFn = dependencies.savePendingSendIntentFn ?? savePendingSendIntent;
  let publishState: PendingPublishState;
  if (idempotencyDecision.type === 'pending') {
    publishState = idempotencyDecision.state;
  } else {
    const accountingFn = dependencies.accountingFn
      ?? ((input: SendAccountingInput) => defaultAccounting(input, dependencies));
    let accounting: SendAccountingDecision;
    try {
      accounting = await accountingFn({
        aiId,
        msgId,
        deliverableCount: deliverable.length,
        nowUnix: receivedAt
      });
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }

    if (!accounting.ok && accounting.error === 'insufficient_credits') {
      return {
        status: 402,
        body: {
          error: 'insufficient_credits',
          credits_needed: accounting.creditsNeeded
        }
      };
    }

    if (!accounting.ok && accounting.error === 'rate_limited') {
      return {
        status: 429,
        body: {
          error: 'rate_limited',
          retry_after: accounting.retryAfter
        }
      };
    }

    if (!accounting.ok && accounting.error === 'internal_error') {
      return { status: 500, body: { error: 'internal_error' } };
    }
    if (!accounting.ok) {
      return { status: 500, body: { error: 'internal_error' } };
    }

    publishState = {
      deliverable: [...deliverable],
      blocked: [...blocked],
      credits_used: accounting.creditsUsed,
      quota_counted: accounting.quotaCounted,
      received_at: receivedAt,
      published_inbox_to: [],
      sent_published: false
    };

    try {
      await savePendingSendIntentFn({
        key: sendIntentKey,
        ai_id: aiId,
        msg_id: msgId,
        payload_hash: payloadHash,
        pending_publish: publishState,
        nowUnix: receivedAt
      });
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }
  }

  const publishEnvelopeFn = dependencies.publishEnvelopeFn ?? publishEnvelope;
  const publishedInboxTo = new Set(publishState.published_inbox_to);
  for (const recipient of publishState.deliverable) {
    if (publishedInboxTo.has(recipient)) {
      continue;
    }
    try {
      const publishInput = {
        msg_id: msgId,
        type: 'inbox' as const,
        from: aiId,
        sender_public_key_spki: sender.public_key_spki,
        sender_schnorr_pubkey: senderSchnorrPubkey,
        to: recipient,
        received_at: receivedAt,
        envelope
      };
      await publishEnvelopeFn(
        publishInput
      );
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }

    publishedInboxTo.add(recipient);
    publishState.published_inbox_to = [...publishedInboxTo];
    try {
      await savePendingSendIntentFn({
        key: sendIntentKey,
        ai_id: aiId,
        msg_id: msgId,
        payload_hash: payloadHash,
        pending_publish: publishState,
        nowUnix: receivedAt
      });
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }
  }

  if (!publishState.sent_published) {
    try {
      const publishInput = {
        msg_id: msgId,
        type: 'sent' as const,
        from: aiId,
        sender_public_key_spki: sender.public_key_spki,
        sender_schnorr_pubkey: senderSchnorrPubkey,
        to: aiId,
        received_at: publishState.received_at,
        envelope
      };
      await publishEnvelopeFn(publishInput);
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }

    publishState.sent_published = true;
    try {
      await savePendingSendIntentFn({
        key: sendIntentKey,
        ai_id: aiId,
        msg_id: msgId,
        payload_hash: payloadHash,
        pending_publish: publishState,
        nowUnix: receivedAt
      });
    } catch {
      return { status: 500, body: { error: 'internal_error' } };
    }
  }

  const response: SendSuccessResponse = {
    msg_id: msgId,
    delivered_to: publishState.deliverable.length,
    blocked: [...publishState.blocked],
    credits_used: publishState.credits_used,
    quota_counted: publishState.quota_counted,
    idempotent_replay: false,
    received_at: publishState.received_at
  };

  const saveCompletedSendIntentFn = dependencies.saveCompletedSendIntentFn ?? saveCompletedSendIntent;
  try {
    await saveCompletedSendIntentFn({
      key: sendIntentKey,
      ai_id: aiId,
      msg_id: msgId,
      payload_hash: payloadHash,
      response,
      nowUnix: receivedAt
    });
  } catch {
    // Delivery has already succeeded at this point; avoid surfacing a 500 that would encourage
    // client retries and potential duplicate publish attempts.
    return {
      status: 200,
      body: response
    };
  }

  return {
    status: 200,
    body: response
  };
}
