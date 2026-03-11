import type { Kind17Envelope } from './envelope.js';
import { computeEnvelopeId } from './envelope.js';
import { extractRecipients, validateEnvelopeContentShape } from './recipients.js';
import { verifySchnorrSignature } from './signature.js';

export const MAX_ENVELOPE_BYTES = 64 * 1024;

export type ValidationErrorCode =
  | 'invalid_schema'
  | 'message_too_large'
  | 'invalid_id'
  | 'invalid_sig'
  | 'too_many_recipients'
  | 'clock_ahead'
  | 'clock_behind';

export interface ValidationResult {
  ok: boolean;
  error?: ValidationErrorCode;
}

export interface ValidateEnvelopeOptions {
  receivedAtUnix: number;
  senderPubkeyHex: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function computeEnvelopeSizeBytes(envelope: Kind17Envelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

export function validateEnvelope(envelope: Kind17Envelope, options: ValidateEnvelopeOptions): ValidationResult {
  if (
    !isNonEmptyString(envelope.id)
    || envelope.kind !== 17
    || !isNonEmptyString(envelope.ai_id)
    || !Number.isInteger(envelope.created_at)
    || !Array.isArray(envelope.tags)
    || !isNonEmptyString(envelope.sig)
    || (typeof envelope.content !== 'string'
      && (typeof envelope.content !== 'object' || envelope.content === null || Array.isArray(envelope.content)))
  ) {
    return { ok: false, error: 'invalid_schema' };
  }

  if (computeEnvelopeSizeBytes(envelope) > MAX_ENVELOPE_BYTES) {
    return { ok: false, error: 'message_too_large' };
  }

  let recipients: string[];
  try {
    recipients = extractRecipients(envelope.tags);
    validateEnvelopeContentShape(envelope, recipients);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'too_many_recipients') {
      return { ok: false, error: 'too_many_recipients' };
    }
    return { ok: false, error: 'invalid_schema' };
  }

  if (envelope.created_at > options.receivedAtUnix + 60) {
    return { ok: false, error: 'clock_ahead' };
  }

  if (envelope.created_at < options.receivedAtUnix - 300) {
    return { ok: false, error: 'clock_behind' };
  }

  const computedId = computeEnvelopeId({
    kind: envelope.kind,
    ai_id: envelope.ai_id,
    created_at: envelope.created_at,
    tags: envelope.tags,
    content: envelope.content
  });

  if (computedId !== envelope.id) {
    return { ok: false, error: 'invalid_id' };
  }

  if (!verifySchnorrSignature(envelope.id, envelope.sig, options.senderPubkeyHex)) {
    return { ok: false, error: 'invalid_sig' };
  }

  return { ok: true };
}
