import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import {
  derivePrincipalFromSpki,
  deriveSchnorrPubkeyFromSpki
} from '../dist/src/domain/signature.js';

function base64UrlToBuffer(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function signHashHex(hashHex, privateKeyHex) {
  return bytesToHex(schnorr.sign(hexToBytes(hashHex), hexToBytes(privateKeyHex)));
}

function createPemPrivateKey() {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    privateKeyEncoding: {
      format: 'pem',
      type: 'sec1'
    }
  });
  return privateKey;
}

export function deriveUserFromPem(label, pem) {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const spkiDerHex = publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const jwk = privateKey.export({ format: 'jwk' });

  if (
    typeof jwk !== 'object'
    || jwk === null
    || typeof jwk.d !== 'string'
  ) {
    throw new Error('invalid_pem_private_key');
  }

  const privateKeyHex = base64UrlToBuffer(jwk.d).toString('hex');
  const schnorrPubkey = deriveSchnorrPubkeyFromSpki(spkiDerHex);
  const aiId = derivePrincipalFromSpki(spkiDerHex);

  return {
    label,
    ai_id: aiId,
    private_key: privateKeyHex,
    public_key_spki: spkiDerHex,
    schnorr_pubkey: schnorrPubkey
  };
}

export function defaultPemPathForLabel(label, usersDir) {
  return path.join(usersDir, `${label}.pem`);
}

export function resolveDfxIdentityPemPath(identityName, homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'dfx', 'identity', identityName, 'identity.pem');
}

export async function loadPemUserFromFile(label, filePath) {
  const pem = await fs.readFile(filePath, 'utf8');
  const user = deriveUserFromPem(label, pem);
  return { ...user, file_path: filePath, created: false };
}

export async function loadOrCreatePemUser(label, usersDir) {
  await ensureDir(usersDir);
  const filePath = defaultPemPathForLabel(label, usersDir);

  try {
    return await loadPemUserFromFile(label, filePath);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const pem = createPemPrivateKey();
  await fs.writeFile(filePath, pem, 'utf8');
  const user = deriveUserFromPem(label, pem);
  return { ...user, file_path: filePath, created: true };
}

export async function resolveUserIdentity(label, usersDir, options = {}) {
  if (typeof options.pemPath === 'string' && options.pemPath.trim().length > 0) {
    return loadPemUserFromFile(label, options.pemPath.trim());
  }

  if (typeof options.dfxIdentity === 'string' && options.dfxIdentity.trim().length > 0) {
    const pemPath = resolveDfxIdentityPemPath(options.dfxIdentity.trim(), options.homeDir);
    return loadPemUserFromFile(label, pemPath);
  }

  if (options.createIfMissing === false) {
    return loadPemUserFromFile(label, defaultPemPathForLabel(label, usersDir));
  }

  return loadOrCreatePemUser(label, usersDir);
}
