import {
  AgentAlreadyRegisteredError,
  type AgentRecord,
  type AgentStore,
  type RegisterAgentInput
} from './agents.js';
import type { FirestoreLike } from './firestoreMailbox.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(record: AgentRecord): AgentRecord {
  const copy: AgentRecord = {
    ai_id: record.ai_id,
    public_key_spki: record.public_key_spki,
    schnorr_pubkey: record.schnorr_pubkey,
    registered_at: record.registered_at
  };
  if (record.name !== undefined) {
    copy.name = record.name;
  }
  return copy;
}

function parseRecord(docId: string, value: unknown): AgentRecord | null {
  if (!isObject(value)) {
    return null;
  }

  const aiId = value.ai_id;
  const publicKeySpki = value.public_key_spki;
  const schnorrPubkey = value.schnorr_pubkey;
  const registeredAt = value.registered_at;
  const name = value.name;
  if (
    typeof aiId !== 'string'
    || aiId !== docId
    || typeof publicKeySpki !== 'string'
    || publicKeySpki.length === 0
    || typeof schnorrPubkey !== 'string'
    || schnorrPubkey.length === 0
    || typeof registeredAt !== 'number'
    || !Number.isInteger(registeredAt)
    || (name !== undefined && typeof name !== 'string')
  ) {
    return null;
  }

  const record: AgentRecord = {
    ai_id: aiId,
    public_key_spki: publicKeySpki,
    schnorr_pubkey: schnorrPubkey,
    registered_at: registeredAt
  };
  if (name !== undefined) {
    record.name = name;
  }
  return record;
}

function toFirestoreRecord(record: AgentRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ai_id: record.ai_id,
    public_key_spki: record.public_key_spki,
    schnorr_pubkey: record.schnorr_pubkey,
    registered_at: record.registered_at
  };
  if (record.name !== undefined) {
    out.name = record.name;
  }
  return out;
}

interface FirestoreCreatableDocumentReferenceLike {
  create(data: Record<string, unknown>): Promise<unknown>;
}

function hasCreateMethod(value: unknown): value is FirestoreCreatableDocumentReferenceLike {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { create?: unknown }).create === 'function';
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS') {
    return true;
  }

  return error.message.toLowerCase().includes('already exists');
}

export class FirestoreAgentStore implements AgentStore {
  constructor(private readonly db: FirestoreLike) {}

  private agentDoc(aiId: string) {
    return this.db.collection('agents').doc(aiId);
  }

  private statsDoc(aiId: string) {
    return this.db.collection(`agents/${aiId}/meta`).doc('stats');
  }

  private preferencesDoc(aiId: string) {
    return this.db.collection(`agents/${aiId}/settings`).doc('preferences');
  }

  async registerAgent(input: RegisterAgentInput): Promise<AgentRecord> {
    const record: AgentRecord = {
      ai_id: input.ai_id,
      public_key_spki: input.public_key_spki,
      schnorr_pubkey: input.schnorr_pubkey,
      registered_at: input.registered_at
    };
    if (input.name !== undefined) {
      record.name = input.name;
    }

    const docRef = this.agentDoc(input.ai_id);
    try {
      if (hasCreateMethod(docRef)) {
        await docRef.create(toFirestoreRecord(record));
      } else if (typeof this.db.runTransaction === 'function') {
        await this.db.runTransaction(async (tx) => {
          const existing = await tx.get(docRef);
          if (existing.exists) {
            throw new AgentAlreadyRegisteredError(input.ai_id);
          }
          tx.set(docRef, toFirestoreRecord(record));
        });
      } else {
        const existing = await docRef.get();
        if (existing.exists) {
          throw new AgentAlreadyRegisteredError(input.ai_id);
        }
        // Compatibility fallback for non-transactional Firestore-like test adapters.
        await docRef.set(toFirestoreRecord(record));
      }
    } catch (error) {
      if (error instanceof AgentAlreadyRegisteredError || isAlreadyExistsError(error)) {
        throw new AgentAlreadyRegisteredError(input.ai_id);
      }
      throw error;
    }

    await Promise.all([
      this.statsDoc(input.ai_id).set(
        {
          unread_count: 0,
          total_received: 0,
          total_sent: 0
        },
        { merge: true }
      ),
      this.preferencesDoc(input.ai_id).set(
        {
          block_list: []
        },
        { merge: true }
      )
    ]);

    return cloneRecord(record);
  }

  async getAgent(aiId: string): Promise<AgentRecord | null> {
    const snapshot = await this.agentDoc(aiId).get();
    if (!snapshot.exists) {
      return null;
    }
    const parsed = parseRecord(snapshot.id, snapshot.data());
    return parsed ? cloneRecord(parsed) : null;
  }

  async isBlocked(recipientAiId: string, senderAiId: string): Promise<boolean> {
    const snapshot = await this.preferencesDoc(recipientAiId).get();
    if (!snapshot.exists) {
      return false;
    }

    const data = snapshot.data();
    if (!data || !Array.isArray(data.block_list)) {
      return false;
    }

    return data.block_list.some((entry) => entry === senderAiId);
  }

  clear(): void {
    // Firestore-backed clear is intentionally a no-op to keep the contract synchronous.
  }
}
