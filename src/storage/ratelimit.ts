import {
  computeQuotaDecision,
  normalizeQuotaState,
  nextUtcMidnightUnix,
  type QuotaDecision,
  type QuotaState
} from '../domain/ratelimit.js';

export interface RateLimitStateStore {
  get(aiId: string): Promise<QuotaState | null>;
  set(aiId: string, state: QuotaState): Promise<void>;
  clear(): void;
}

export interface AtomicRateLimitStateStore extends RateLimitStateStore {
  updateAndDecide(aiId: string, deliverableCount: number, nowUnix: number): Promise<QuotaDecision>;
  rollbackConsumedQuota?(aiId: string, deliverableCount: number, nowUnix: number): Promise<void>;
}

type RollbackRateLimitStateStore = AtomicRateLimitStateStore & {
  rollbackConsumedQuota(aiId: string, deliverableCount: number, nowUnix: number): Promise<void>;
};

function cloneState(state: QuotaState): QuotaState {
  return {
    daily_send_count: state.daily_send_count,
    daily_send_reset_at: state.daily_send_reset_at,
    burst_count: state.burst_count,
    burst_reset_at: state.burst_reset_at
  };
}

function initialState(nowUnix: number): QuotaState {
  return {
    daily_send_count: 0,
    daily_send_reset_at: nextUtcMidnightUnix(nowUnix),
    burst_count: 0,
    burst_reset_at: nowUnix
  };
}

function decrementConsumedQuota(state: QuotaState, deliverableCount: number, nowUnix: number): QuotaState {
  const normalized = normalizeQuotaState(state, nowUnix);
  return {
    daily_send_count: Math.max(0, normalized.daily_send_count - deliverableCount),
    daily_send_reset_at: normalized.daily_send_reset_at,
    burst_count: Math.max(0, normalized.burst_count - deliverableCount),
    burst_reset_at: normalized.burst_reset_at
  };
}

function hasAtomicUpdate(store: RateLimitStateStore): store is AtomicRateLimitStateStore {
  return typeof (store as { updateAndDecide?: unknown }).updateAndDecide === 'function';
}

function hasRollbackConsumedQuota(store: RateLimitStateStore): store is RollbackRateLimitStateStore {
  return typeof (store as { rollbackConsumedQuota?: unknown }).rollbackConsumedQuota === 'function';
}

export class InMemoryRateLimitStateStore implements AtomicRateLimitStateStore {
  private readonly states = new Map<string, QuotaState>();

  async get(aiId: string): Promise<QuotaState | null> {
    const found = this.states.get(aiId);
    return found ? cloneState(found) : null;
  }

  async set(aiId: string, state: QuotaState): Promise<void> {
    this.states.set(aiId, cloneState(state));
  }

  async updateAndDecide(aiId: string, deliverableCount: number, nowUnix: number): Promise<QuotaDecision> {
    const current = this.states.get(aiId) ? cloneState(this.states.get(aiId) as QuotaState) : initialState(nowUnix);
    const decision = computeQuotaDecision(current, deliverableCount, nowUnix);
    if (decision.allowed) {
      this.states.set(aiId, cloneState(decision.next_state));
    } else if (!this.states.has(aiId)) {
      this.states.set(aiId, cloneState(current));
    }
    return decision;
  }

  async rollbackConsumedQuota(aiId: string, deliverableCount: number, nowUnix: number): Promise<void> {
    if (!Number.isInteger(deliverableCount) || deliverableCount <= 0) {
      return;
    }
    const current = this.states.get(aiId) ? cloneState(this.states.get(aiId) as QuotaState) : initialState(nowUnix);
    const rolledBack = decrementConsumedQuota(current, deliverableCount, nowUnix);
    this.states.set(aiId, cloneState(rolledBack));
  }

  clear(): void {
    this.states.clear();
  }
}

let defaultRateLimitStateStore: RateLimitStateStore = new InMemoryRateLimitStateStore();

export function getDefaultRateLimitStateStore(): RateLimitStateStore {
  return defaultRateLimitStateStore;
}

export function setDefaultRateLimitStateStore(store: RateLimitStateStore): void {
  defaultRateLimitStateStore = store;
}

export function clearDefaultRateLimitStateStore(): void {
  defaultRateLimitStateStore.clear();
}

export async function getRateLimitState(
  aiId: string,
  nowUnix: number,
  store: RateLimitStateStore = defaultRateLimitStateStore
): Promise<QuotaState> {
  const found = await store.get(aiId);
  if (found) {
    return cloneState(found);
  }

  const initial = initialState(nowUnix);
  await store.set(aiId, initial);
  return initial;
}

export async function previewRateLimitDecision(
  aiId: string,
  deliverableCount: number,
  nowUnix: number,
  store: RateLimitStateStore = defaultRateLimitStateStore
): Promise<QuotaDecision> {
  const state = await getRateLimitState(aiId, nowUnix, store);
  return computeQuotaDecision(state, deliverableCount, nowUnix);
}

export async function commitRateLimitState(
  aiId: string,
  nextState: QuotaState,
  store: RateLimitStateStore = defaultRateLimitStateStore
): Promise<void> {
  await store.set(aiId, nextState);
}

export async function updateRateLimitState(
  aiId: string,
  deliverableCount: number,
  nowUnix: number,
  store: RateLimitStateStore = defaultRateLimitStateStore
): Promise<QuotaDecision> {
  if (hasAtomicUpdate(store)) {
    return store.updateAndDecide(aiId, deliverableCount, nowUnix);
  }

  const decision = await previewRateLimitDecision(aiId, deliverableCount, nowUnix, store);
  if (decision.allowed) {
    await commitRateLimitState(aiId, decision.next_state, store);
  }
  return decision;
}

export async function rollbackRateLimitState(
  aiId: string,
  deliverableCount: number,
  nowUnix: number,
  store: RateLimitStateStore = defaultRateLimitStateStore
): Promise<void> {
  if (!Number.isInteger(deliverableCount) || deliverableCount <= 0) {
    return;
  }

  if (hasRollbackConsumedQuota(store)) {
    await store.rollbackConsumedQuota(aiId, deliverableCount, nowUnix);
    return;
  }

  const current = await getRateLimitState(aiId, nowUnix, store);
  const rolledBack = decrementConsumedQuota(current, deliverableCount, nowUnix);
  await store.set(aiId, rolledBack);
}
