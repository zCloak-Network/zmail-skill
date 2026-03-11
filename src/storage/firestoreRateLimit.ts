import {
  computeQuotaDecision,
  normalizeQuotaState,
  nextUtcMidnightUnix,
  type QuotaDecision,
  type QuotaState
} from '../domain/ratelimit.js';
import type { FirestoreLike } from './firestoreMailbox.js';
import type { AtomicRateLimitStateStore } from './ratelimit.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneState(state: QuotaState): QuotaState {
  return {
    daily_send_count: state.daily_send_count,
    daily_send_reset_at: state.daily_send_reset_at,
    burst_count: state.burst_count,
    burst_reset_at: state.burst_reset_at
  };
}

function parseState(value: unknown): QuotaState | null {
  if (!isObject(value)) {
    return null;
  }

  const dailySendCount = value.daily_send_count;
  const dailySendResetAt = value.daily_send_reset_at;
  const burstCount = value.burst_count;
  const burstResetAt = value.burst_reset_at;
  if (
    typeof dailySendCount !== 'number'
    || !Number.isInteger(dailySendCount)
    || typeof dailySendResetAt !== 'number'
    || !Number.isInteger(dailySendResetAt)
    || typeof burstCount !== 'number'
    || !Number.isInteger(burstCount)
    || typeof burstResetAt !== 'number'
    || !Number.isInteger(burstResetAt)
  ) {
    return null;
  }

  return {
    daily_send_count: dailySendCount,
    daily_send_reset_at: dailySendResetAt,
    burst_count: burstCount,
    burst_reset_at: burstResetAt
  };
}

function toFirestoreState(state: QuotaState): Record<string, unknown> {
  return {
    daily_send_count: state.daily_send_count,
    daily_send_reset_at: state.daily_send_reset_at,
    burst_count: state.burst_count,
    burst_reset_at: state.burst_reset_at
  };
}

export class FirestoreRateLimitStateStore implements AtomicRateLimitStateStore {
  constructor(private readonly db: FirestoreLike) {}

  private statsDoc(aiId: string) {
    return this.db.collection(`agents/${aiId}/meta`).doc('stats');
  }

  async get(aiId: string): Promise<QuotaState | null> {
    const snapshot = await this.statsDoc(aiId).get();
    if (!snapshot.exists) {
      return null;
    }
    const state = parseState(snapshot.data());
    return state ? cloneState(state) : null;
  }

  async set(aiId: string, state: QuotaState): Promise<void> {
    await this.statsDoc(aiId).set(toFirestoreState(state), { merge: true });
  }

  private initialState(nowUnix: number): QuotaState {
    return {
      daily_send_count: 0,
      daily_send_reset_at: nextUtcMidnightUnix(nowUnix),
      burst_count: 0,
      burst_reset_at: nowUnix
    };
  }

  private decrementConsumedQuota(state: QuotaState, deliverableCount: number, nowUnix: number): QuotaState {
    const normalized = normalizeQuotaState(state, nowUnix);
    return {
      daily_send_count: Math.max(0, normalized.daily_send_count - deliverableCount),
      daily_send_reset_at: normalized.daily_send_reset_at,
      burst_count: Math.max(0, normalized.burst_count - deliverableCount),
      burst_reset_at: normalized.burst_reset_at
    };
  }

  async updateAndDecide(aiId: string, deliverableCount: number, nowUnix: number): Promise<QuotaDecision> {
    const runTransaction = this.db.runTransaction?.bind(this.db);
    if (typeof runTransaction !== 'function') {
      const current = await this.get(aiId);
      const base = current ? cloneState(current) : this.initialState(nowUnix);
      const decision = computeQuotaDecision(base, deliverableCount, nowUnix);
      if (decision.allowed) {
        await this.set(aiId, decision.next_state);
      } else if (!current) {
        await this.set(aiId, base);
      }
      return decision;
    }

    const docRef = this.statsDoc(aiId);
    return runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      const parsed = parseState(snapshot.data());
      const base = parsed ? cloneState(parsed) : this.initialState(nowUnix);
      const decision = computeQuotaDecision(base, deliverableCount, nowUnix);
      if (decision.allowed) {
        tx.set(docRef, toFirestoreState(decision.next_state), { merge: true });
      } else if (!parsed) {
        tx.set(docRef, toFirestoreState(base), { merge: true });
      }
      return decision;
    });
  }

  async rollbackConsumedQuota(aiId: string, deliverableCount: number, nowUnix: number): Promise<void> {
    if (!Number.isInteger(deliverableCount) || deliverableCount <= 0) {
      return;
    }

    const runTransaction = this.db.runTransaction?.bind(this.db);
    if (typeof runTransaction !== 'function') {
      const current = await this.get(aiId);
      const base = current ? cloneState(current) : this.initialState(nowUnix);
      const rolledBack = this.decrementConsumedQuota(base, deliverableCount, nowUnix);
      await this.set(aiId, rolledBack);
      return;
    }

    const docRef = this.statsDoc(aiId);
    await runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      const parsed = parseState(snapshot.data());
      const base = parsed ? cloneState(parsed) : this.initialState(nowUnix);
      const rolledBack = this.decrementConsumedQuota(base, deliverableCount, nowUnix);
      tx.set(docRef, toFirestoreState(rolledBack), { merge: true });
    });
  }

  clear(): void {
    // Firestore-backed clear is intentionally a no-op to keep the contract synchronous.
  }
}
