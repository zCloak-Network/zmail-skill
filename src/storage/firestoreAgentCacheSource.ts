import type { FirestoreLike } from './firestoreMailbox.js';

const DEFAULT_AGENT_CACHE_PAGE_SIZE = 500;

export interface AgentCacheRow {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  registered_at: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRow(row: AgentCacheRow): AgentCacheRow {
  const copy: AgentCacheRow = {
    ai_id: row.ai_id,
    public_key_spki: row.public_key_spki,
    schnorr_pubkey: row.schnorr_pubkey,
    registered_at: row.registered_at
  };
  return copy;
}

function parseRow(docId: string, value: unknown): AgentCacheRow | null {
  if (!isObject(value)) {
    return null;
  }

  const aiId = value.ai_id;
  const publicKeySpki = value.public_key_spki;
  const schnorrPubkey = value.schnorr_pubkey;
  const registeredAt = value.registered_at;
  if (
    typeof aiId !== 'string'
    || aiId.length === 0
    || aiId !== docId
    || typeof publicKeySpki !== 'string'
    || publicKeySpki.length === 0
    || typeof schnorrPubkey !== 'string'
    || schnorrPubkey.length === 0
    || typeof registeredAt !== 'number'
    || !Number.isInteger(registeredAt)
    || registeredAt < 0
  ) {
    return null;
  }

  const row: AgentCacheRow = {
    ai_id: aiId,
    public_key_spki: publicKeySpki,
    schnorr_pubkey: schnorrPubkey,
    registered_at: registeredAt
  };
  return row;
}

function normalizePageSize(rawPageSize: number): number {
  if (Number.isInteger(rawPageSize) && rawPageSize > 0) {
    return rawPageSize;
  }
  return DEFAULT_AGENT_CACHE_PAGE_SIZE;
}

function parseRegisteredAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export class FirestoreAgentCacheSource {
  private readonly pageSize: number;

  constructor(
    private readonly db: FirestoreLike,
    pageSize: number = DEFAULT_AGENT_CACHE_PAGE_SIZE
  ) {
    this.pageSize = normalizePageSize(pageSize);
  }

  private agentsCollection() {
    return this.db.collection('agents');
  }

  async listAgentsRegisteredBetween(fromInclusiveUnix: number, toInclusiveUnix: number): Promise<AgentCacheRow[]> {
    if (toInclusiveUnix < fromInclusiveUnix) {
      return [];
    }

    const rows: AgentCacheRow[] = [];
    let startAfterRegisteredAt: number | null = null;
    let startAfterDocId: string | null = null;

    while (true) {
      let query = this.agentsCollection()
        .where('registered_at', '>=', fromInclusiveUnix)
        .where('registered_at', '<=', toInclusiveUnix)
        .orderBy('registered_at', 'asc')
        .orderBy('__name__', 'asc')
        .limit(this.pageSize);
      if (startAfterRegisteredAt !== null && startAfterDocId !== null) {
        query = query.startAfter(startAfterRegisteredAt, startAfterDocId);
      }

      const snapshot = await query.get();
      if (snapshot.docs.length === 0) {
        break;
      }

      for (const doc of snapshot.docs) {
        const parsed = parseRow(doc.id, doc.data());
        if (parsed) {
          rows.push(cloneRow(parsed));
        }
      }

      const lastDoc = snapshot.docs[snapshot.docs.length - 1];
      if (!lastDoc) {
        break;
      }
      const lastRegisteredAt = parseRegisteredAt(lastDoc.data()?.registered_at);
      if (lastRegisteredAt === null) {
        break;
      }
      startAfterRegisteredAt = lastRegisteredAt;
      startAfterDocId = lastDoc.id;

      if (snapshot.docs.length < this.pageSize) {
        break;
      }
    }

    return rows;
  }
}
