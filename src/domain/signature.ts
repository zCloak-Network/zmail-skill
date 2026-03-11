import { createPublicKey } from 'node:crypto';
import { Principal } from '@dfinity/principal';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

export interface RegisterPayload {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  timestamp: number;
  sig: string;
}

const UNCOMPRESSED_SECP256K1_SPKI_PREFIX = hexToBytes('3056301006072a8648ce3d020106052b8104000a034200');

function isHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

function validateHexBytes(name: string, hex: string, expectedBytes: number): void {
  if (hex.length !== expectedBytes * 2 || !isHex(hex)) {
    throw new Error(`invalid_${name}`);
  }
}

function hexToBuffer(hex: string, name: string): Buffer {
  if (hex.length % 2 !== 0 || !isHex(hex)) {
    throw new Error(`invalid_${name}`);
  }
  return Buffer.from(hex, 'hex');
}

function base64UrlToBuffer(value: string): Buffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function derEncodeUncompressedSecp256k1Pubkey(uncompressedPubkeyHex: string): Uint8Array {
  validateHexBytes('uncompressed_pubkey', uncompressedPubkeyHex, 65);
  const out = new Uint8Array(UNCOMPRESSED_SECP256K1_SPKI_PREFIX.length + 65);
  out.set(UNCOMPRESSED_SECP256K1_SPKI_PREFIX, 0);
  out.set(hexToBytes(uncompressedPubkeyHex), UNCOMPRESSED_SECP256K1_SPKI_PREFIX.length);
  return out;
}

function parseSpkiPublicKey(publicKeySpkiHex: string) {
  const der = hexToBuffer(publicKeySpkiHex, 'public_key_spki');
  let key;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('invalid_public_key_spki');
  }

  const jwk = key.export({ format: 'jwk' });
  if (
    typeof jwk !== 'object'
    || jwk === null
    || jwk.kty !== 'EC'
    || jwk.crv !== 'secp256k1'
    || typeof jwk.x !== 'string'
    || typeof jwk.y !== 'string'
  ) {
    throw new Error('invalid_public_key_spki');
  }

  return {
    der,
    jwk: {
      x: jwk.x,
      y: jwk.y
    }
  };
}

export function verifySchnorrSignature(msgHashHex: string, signatureHex: string, pubkeyHex: string): boolean {
  try {
    validateHexBytes('msg_hash', msgHashHex, 32);
    validateHexBytes('signature', signatureHex, 64);
    validateHexBytes('pubkey', pubkeyHex, 32);
    return schnorr.verify(hexToBytes(signatureHex), hexToBytes(msgHashHex), hexToBytes(pubkeyHex));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('invalid_')) {
      if (error instanceof Error) {
        console.debug('[signature] verify_schnorr_error', {
          name: error.name,
          message: error.message
        });
      } else {
        console.debug('[signature] verify_schnorr_error', {
          message: String(error)
        });
      }
    }
    return false;
  }
}

export function derivePrincipalFromSpki(publicKeySpkiHex: string): string {
  const { der } = parseSpkiPublicKey(publicKeySpkiHex);
  return Principal.selfAuthenticating(new Uint8Array(der)).toText();
}

export function deriveSchnorrPubkeyFromSpki(publicKeySpkiHex: string): string {
  const { jwk } = parseSpkiPublicKey(publicKeySpkiHex);
  return base64UrlToBuffer(jwk.x).toString('hex');
}

export function verifyPrincipalMatchesSpki(aiId: string, publicKeySpkiHex: string): boolean {
  try {
    return derivePrincipalFromSpki(publicKeySpkiHex) === aiId;
  } catch {
    return false;
  }
}

export function verifySchnorrPubkeyMatchesSpki(schnorrPubkeyHex: string, publicKeySpkiHex: string): boolean {
  try {
    validateHexBytes('pubkey', schnorrPubkeyHex, 32);
    return deriveSchnorrPubkeyFromSpki(publicKeySpkiHex) === schnorrPubkeyHex;
  } catch {
    return false;
  }
}

export function deriveSpkiFromPrivateKey(privateKeyHex: string): string {
  validateHexBytes('private_key', privateKeyHex, 32);
  const uncompressedPubkeyHex = Buffer.from(secp256k1.getPublicKey(hexToBytes(privateKeyHex), false)).toString('hex');
  return Buffer.from(derEncodeUncompressedSecp256k1Pubkey(uncompressedPubkeyHex)).toString('hex');
}

export function deriveIdentityFromPrivateKey(privateKeyHex: string): {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
} {
  validateHexBytes('private_key', privateKeyHex, 32);
  const publicKeySpki = deriveSpkiFromPrivateKey(privateKeyHex);
  const schnorrPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
  return {
    ai_id: derivePrincipalFromSpki(publicKeySpki),
    public_key_spki: publicKeySpki,
    schnorr_pubkey: schnorrPubkey
  };
}
