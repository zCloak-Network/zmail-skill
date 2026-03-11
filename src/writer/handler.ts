import type { Kind17Envelope } from '../domain/envelope.js';
import { extractRecipients } from '../domain/recipients.js';
import {
  verifyPrincipalMatchesSpki,
  verifySchnorrPubkeyMatchesSpki
} from '../domain/signature.js';
import { validateEnvelope } from '../domain/validation.js';
import { writeInboxMessage, writeSentMessage } from '../storage/inbox.js';
import type { PubSubPushEnvelope } from '../pubsub/publisher.js';

export interface WriterPushRequest {
  body: unknown;
}

export type WriterPushResponse =
  | { status: 200; body: { ok: true } }
  | { status: 400; body: { error: 'invalid_pubsub_message' | 'unknown_type' } }
  | { status: 500; body: { error: 'internal_error' } };

export interface WriterHandlerDependencies {
  nowUnix?: () => number;
  writeInboxMessageFn?: typeof writeInboxMessage;
  writeSentMessageFn?: typeof writeSentMessage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePushEnvelope(value: unknown): PubSubPushEnvelope | null {
  if (!isObject(value)) {
    return null;
  }

  const message = value.message;
  if (!isObject(message)) {
    return null;
  }

  const data = message.data;
  const attributes = message.attributes;
  const messageId = message.messageId;
  if (typeof data !== 'string' || !isObject(attributes) || typeof messageId !== 'string') {
    return null;
  }

  const msgId = attributes.msg_id;
  const type = attributes.type;
  const from = attributes.from;
  const senderPublicKeySpki = attributes.sender_public_key_spki;
  const senderSchnorrPubkey = attributes.sender_schnorr_pubkey;
  const to = attributes.to;
  const receivedAt = attributes.received_at;
  if (
    typeof msgId !== 'string'
    || (type !== 'inbox' && type !== 'sent')
    || typeof from !== 'string'
    || typeof senderPublicKeySpki !== 'string'
    || senderPublicKeySpki.length === 0
    || typeof senderSchnorrPubkey !== 'string'
    || senderSchnorrPubkey.length === 0
    || typeof to !== 'string'
    || typeof receivedAt !== 'string'
  ) {
    return null;
  }

  return value as unknown as PubSubPushEnvelope;
}

function parseEnvelopeBase64(data: string): Kind17Envelope | null {
  try {
    const json = Buffer.from(data, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (!isObject(parsed)) {
      return null;
    }
    return parsed as unknown as Kind17Envelope;
  } catch {
    return null;
  }
}

export async function handlePubSubPush(
  request: WriterPushRequest,
  dependencies: WriterHandlerDependencies = {}
): Promise<WriterPushResponse> {
  const pushEnvelope = parsePushEnvelope(request.body);
  if (!pushEnvelope) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  const envelope = parseEnvelopeBase64(pushEnvelope.message.data);
  if (!envelope) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  const messageType = pushEnvelope.message.attributes.type;
  if (messageType !== 'inbox' && messageType !== 'sent') {
    return { status: 400, body: { error: 'unknown_type' } };
  }

  const receivedAt = Number(pushEnvelope.message.attributes.received_at);
  if (!Number.isInteger(receivedAt) || receivedAt < 0) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  if (pushEnvelope.message.attributes.msg_id !== envelope.id) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  if (pushEnvelope.message.attributes.from !== envelope.ai_id) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  const senderValidationPubkey = pushEnvelope.message.attributes.sender_schnorr_pubkey;
  if (!verifyPrincipalMatchesSpki(envelope.ai_id, pushEnvelope.message.attributes.sender_public_key_spki)) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  if (!verifySchnorrPubkeyMatchesSpki(
    senderValidationPubkey,
    pushEnvelope.message.attributes.sender_public_key_spki
  )) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  const validation = validateEnvelope(envelope, {
    receivedAtUnix: receivedAt,
    senderPubkeyHex: senderValidationPubkey
  });
  if (!validation.ok) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  let recipients: string[];
  try {
    recipients = extractRecipients(envelope.tags);
  } catch {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  if (messageType === 'inbox' && !recipients.includes(pushEnvelope.message.attributes.to)) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  if (messageType === 'sent' && pushEnvelope.message.attributes.to !== pushEnvelope.message.attributes.from) {
    return { status: 400, body: { error: 'invalid_pubsub_message' } };
  }

  const nowUnix = dependencies.nowUnix ?? (() => Math.floor(Date.now() / 1000));
  const storedAt = nowUnix();

  try {
    if (messageType === 'inbox') {
      const writeInbox = dependencies.writeInboxMessageFn ?? writeInboxMessage;
      await writeInbox(pushEnvelope.message.attributes.to, envelope, receivedAt, storedAt);
    } else {
      const writeSent = dependencies.writeSentMessageFn ?? writeSentMessage;
      await writeSent(pushEnvelope.message.attributes.from, envelope, receivedAt, storedAt);
    }
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorMessage = error instanceof Error ? error.message : 'unknown_error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(JSON.stringify({
      service: 'writer',
      event: 'push_write_error',
      error_name: errorName,
      error_message: errorMessage,
      error_stack: errorStack
    }));
    return { status: 500, body: { error: 'internal_error' } };
  }

  return {
    status: 200,
    body: { ok: true }
  };
}
