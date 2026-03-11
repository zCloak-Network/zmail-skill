import { createHash } from 'node:crypto';

export type EnvelopeTag = [string, ...string[]];

export interface Kind17Envelope {
  id: string;
  kind: 17;
  ai_id: string;
  created_at: number;
  tags: EnvelopeTag[];
  content: string | Record<string, string>;
  sig: string;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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

    for (const [key, nestedValue] of entries) {
      out[normalizeText(key)] = canonicalize(nestedValue);
    }

    return out;
  }

  return value;
}

function buildEnvelopeIdPayload(envelope: Pick<Kind17Envelope, 'ai_id' | 'created_at' | 'tags' | 'content'>): unknown[] {
  return [
    0,
    normalizeText(envelope.ai_id),
    envelope.created_at,
    17,
    canonicalize(envelope.tags),
    canonicalize(envelope.content)
  ];
}

export function canonicalSerializeEnvelopeForId(envelope: Kind17Envelope): string {
  return JSON.stringify(buildEnvelopeIdPayload(envelope));
}

export function computeEnvelopeId(envelope: Omit<Kind17Envelope, 'id' | 'sig'>): string {
  const serialized = JSON.stringify(buildEnvelopeIdPayload(envelope));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
