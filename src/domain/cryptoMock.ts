import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface EncryptForRecipientOptions {
  deterministic?: boolean;
}

export interface EncryptForRecipientsOptions {
  deterministic?: boolean;
}

export interface CryptoAdapter {
  encryptForRecipient(plaintext: string, recipientAiId: string, options?: EncryptForRecipientOptions): string;
  decryptForRecipient(ciphertextBase64: string, recipientAiId: string): string;
  encryptForRecipients(
    plaintext: string,
    recipients: string[],
    options?: EncryptForRecipientsOptions
  ): string | Record<string, string>;
}

export interface MockVetKeyCryptoOptions {
  masterSecret?: string;
  deterministicDefault?: boolean;
}

function toUtf8Buffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function deriveAesKey(masterSecret: Buffer, recipientAiId: string): Buffer {
  return createHmac('sha256', masterSecret).update(`vetkey:${recipientAiId}`, 'utf8').digest();
}

function deriveDeterministicIv(key: Buffer, plaintext: string): Buffer {
  return createHmac('sha256', key).update(`iv:${plaintext}`, 'utf8').digest().subarray(0, 12);
}

export class MockVetKeyCrypto implements CryptoAdapter {
  private readonly masterSecret: Buffer;
  private readonly deterministicDefault: boolean;

  constructor(options: MockVetKeyCryptoOptions = {}) {
    this.masterSecret = toUtf8Buffer(options.masterSecret ?? 'zmail-dev-vetkey-secret');
    this.deterministicDefault = options.deterministicDefault ?? false;
  }

  encryptForRecipient(plaintext: string, recipientAiId: string, options: EncryptForRecipientOptions = {}): string {
    if (!isNonEmptyString(plaintext) || !isNonEmptyString(recipientAiId)) {
      throw new Error('invalid_crypto_input');
    }

    const key = deriveAesKey(this.masterSecret, recipientAiId);
    const deterministic = options.deterministic ?? this.deterministicDefault;
    const iv = deterministic ? deriveDeterministicIv(key, plaintext) : randomBytes(12);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, tag]).toString('base64');
  }

  decryptForRecipient(ciphertextBase64: string, recipientAiId: string): string {
    if (!isNonEmptyString(ciphertextBase64) || !isNonEmptyString(recipientAiId)) {
      throw new Error('invalid_crypto_input');
    }

    const raw = Buffer.from(ciphertextBase64, 'base64');
    if (raw.length < 12 + 16) {
      throw new Error('invalid_ciphertext');
    }

    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(12, raw.length - 16);
    const key = deriveAesKey(this.masterSecret, recipientAiId);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  encryptForRecipients(
    plaintext: string,
    recipients: string[],
    options: EncryptForRecipientsOptions = {}
  ): string | Record<string, string> {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error('invalid_recipients');
    }
    if (new Set(recipients).size !== recipients.length) {
      throw new Error('duplicate_recipient');
    }

    if (recipients.length === 1) {
      const recipient = recipients[0];
      if (!recipient) {
        throw new Error('invalid_recipients');
      }
      return this.encryptForRecipient(plaintext, recipient, options);
    }

    const out: Record<string, string> = {};
    for (const recipient of recipients) {
      out[recipient] = this.encryptForRecipient(plaintext, recipient, options);
    }
    return out;
  }
}
