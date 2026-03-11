export interface QuotaState {
  daily_send_count: number;
  daily_send_reset_at: number;
  burst_count: number;
  burst_reset_at: number;
}

export interface QuotaDecision {
  allowed: boolean;
  credits_needed: number;
  quota_counted: number;
  next_state: QuotaState;
  retry_after?: number;
}

export const DAILY_FREE_TIER_LIMIT = 50;
export const BURST_LIMIT_PER_MINUTE = 30;
export const BURST_WINDOW_SECONDS = 60;

export function nextUtcMidnightUnix(nowUnix: number): number {
  const now = new Date(nowUnix * 1000);
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0
  );
  return Math.floor(nextMidnight / 1000);
}

export function normalizeQuotaState(state: QuotaState, nowUnix: number): QuotaState {
  const normalized: QuotaState = {
    daily_send_count: state.daily_send_count,
    daily_send_reset_at: state.daily_send_reset_at,
    burst_count: state.burst_count,
    burst_reset_at: state.burst_reset_at
  };

  if (nowUnix >= normalized.daily_send_reset_at) {
    normalized.daily_send_count = 0;
    normalized.daily_send_reset_at = nextUtcMidnightUnix(nowUnix);
  }

  if (nowUnix - normalized.burst_reset_at >= BURST_WINDOW_SECONDS) {
    normalized.burst_count = 0;
    normalized.burst_reset_at = nowUnix;
  }

  return normalized;
}

export function computeQuotaDecision(state: QuotaState, deliverableCount: number, nowUnix: number): QuotaDecision {
  if (!Number.isInteger(deliverableCount) || deliverableCount <= 0) {
    throw new Error('invalid_deliverable_count');
  }

  const normalized = normalizeQuotaState(state, nowUnix);
  const nextState: QuotaState = {
    daily_send_count: normalized.daily_send_count,
    daily_send_reset_at: normalized.daily_send_reset_at,
    burst_count: normalized.burst_count,
    burst_reset_at: normalized.burst_reset_at
  };

  if (nextState.burst_count + deliverableCount > BURST_LIMIT_PER_MINUTE) {
    const elapsed = Math.max(0, nowUnix - nextState.burst_reset_at);
    const retryAfter = Math.max(1, BURST_WINDOW_SECONDS - elapsed);
    return {
      allowed: false,
      credits_needed: 0,
      quota_counted: 0,
      next_state: nextState,
      retry_after: retryAfter
    };
  }

  const projectedDaily = nextState.daily_send_count + deliverableCount;
  const creditsNeeded = Math.max(0, projectedDaily - DAILY_FREE_TIER_LIMIT);

  nextState.daily_send_count = projectedDaily;
  nextState.burst_count = nextState.burst_count + deliverableCount;

  return {
    allowed: true,
    credits_needed: creditsNeeded,
    quota_counted: deliverableCount,
    next_state: nextState
  };
}
