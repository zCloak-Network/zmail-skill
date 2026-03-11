import type { EnvelopeTag, Kind17Envelope } from './envelope.js';

export function extractRecipients(tags: EnvelopeTag[]): string[] {
  const recipients = tags
    .filter((tag) => tag[0] === 'to')
    .map((tag) => tag[1] ?? '');

  if (recipients.length === 0) {
    throw new Error('missing_to');
  }

  if (recipients.length > 10) {
    throw new Error('too_many_recipients');
  }

  if (recipients.some((recipient) => recipient.length === 0)) {
    throw new Error('invalid_recipient');
  }

  if (new Set(recipients).size !== recipients.length) {
    throw new Error('duplicate_recipient');
  }

  return recipients;
}

export function validateEnvelopeContentShape(_envelope: Kind17Envelope, _recipients: string[]): void {
  const content = _envelope.content;

  if (_recipients.length === 1) {
    if (typeof content !== 'string') {
      throw new Error('content_must_be_string_for_single');
    }
    return;
  }

  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new Error('content_must_be_map_for_multiple');
  }

  const keys = Object.keys(content);
  const recipientSet = new Set(_recipients);

  if (keys.length !== _recipients.length) {
    throw new Error('content_keys_mismatch');
  }

  for (const key of keys) {
    if (!recipientSet.has(key)) {
      throw new Error('content_keys_mismatch');
    }

    if (typeof content[key] !== 'string') {
      throw new Error('invalid_content_value');
    }
  }
}
