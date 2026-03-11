export interface MockCreditDeductReplay {
  ai_id: string;
  amount: number;
  deducted: number;
  balance: number;
}

export interface MockExternalApisState {
  defaultCredit: number;
  balances: Map<string, number>;
  unboundAgents: Set<string>;
  creditDeductIdempotency: Map<string, MockCreditDeductReplay>;
}

export interface CreateMockExternalApisStateOptions {
  defaultCredit?: number;
  unboundAgents?: Iterable<string>;
  initialBalances?: Iterable<readonly [string, number]>;
}

export interface MockExternalApisRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface MockExternalApisResponse {
  status: number;
  body: Record<string, unknown>;
}

function normalizeDefaultCredit(input: number | undefined): number {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0) {
    return input;
  }
  return Number.MAX_SAFE_INTEGER;
}

function normalizeBalance(input: number): number | null {
  if (!Number.isFinite(input) || !Number.isInteger(input) || input < 0) {
    return null;
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePathSegment(input: string): string | null {
  try {
    const decoded = decodeURIComponent(input);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function readAiIdFromOwnerPath(path: string): string | null {
  const match = path.match(/^\/owner-api\/v1\/agents\/([^/]+)\/binding$/);
  if (!match || !match[1]) {
    return null;
  }
  return decodePathSegment(match[1]);
}

function readAiIdFromCreditBalancePath(path: string): string | null {
  const match = path.match(/^\/credit-api\/v1\/balance\/([^/]+)$/);
  if (!match || !match[1]) {
    return null;
  }
  return decodePathSegment(match[1]);
}

export function createMockExternalApisState(options: CreateMockExternalApisStateOptions = {}): MockExternalApisState {
  const defaultCredit = normalizeDefaultCredit(options.defaultCredit);
  const balances = new Map<string, number>();
  const unboundAgents = new Set<string>();

  for (const aiId of options.unboundAgents ?? []) {
    if (typeof aiId === 'string' && aiId.length > 0) {
      unboundAgents.add(aiId);
    }
  }

  for (const [aiId, balance] of options.initialBalances ?? []) {
    if (typeof aiId !== 'string' || aiId.length === 0) {
      continue;
    }
    const normalized = normalizeBalance(balance);
    if (normalized === null) {
      continue;
    }
    balances.set(aiId, normalized);
  }

  return {
    defaultCredit,
    balances,
    unboundAgents,
    creditDeductIdempotency: new Map<string, MockCreditDeductReplay>()
  };
}

function handleOwnerBinding(request: MockExternalApisRequest, state: MockExternalApisState): MockExternalApisResponse {
  if (request.method !== 'GET') {
    return { status: 404, body: { error: 'not_found' } };
  }

  const aiId = readAiIdFromOwnerPath(request.path);
  if (!aiId) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const bound = !state.unboundAgents.has(aiId);
  return {
    status: 200,
    body: {
      bound,
      owner: bound ? `owner-${aiId}` : null,
      tier: bound ? 'basic' : null
    }
  };
}

function handleCreditBalance(request: MockExternalApisRequest, state: MockExternalApisState): MockExternalApisResponse {
  if (request.method !== 'GET') {
    return { status: 404, body: { error: 'not_found' } };
  }

  const aiId = readAiIdFromCreditBalancePath(request.path);
  if (!aiId) {
    return { status: 404, body: { error: 'not_found' } };
  }

  return {
    status: 200,
    body: {
      ai_id: aiId,
      balance: state.balances.get(aiId) ?? state.defaultCredit
    }
  };
}

function handleCreditDeduct(request: MockExternalApisRequest, state: MockExternalApisState): MockExternalApisResponse {
  if (request.method !== 'POST' || request.path !== '/credit-api/v1/deduct') {
    return { status: 404, body: { error: 'not_found' } };
  }

  if (!isRecord(request.body)) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const aiId = typeof request.body.ai_id === 'string' ? request.body.ai_id : '';
  const amount = typeof request.body.amount === 'number' ? request.body.amount : NaN;
  const idempotencyKey = request.body.idempotency_key;

  if (
    aiId.length === 0
    || !Number.isInteger(amount)
    || amount < 0
    || (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0))
  ) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  if (typeof idempotencyKey === 'string') {
    const replay = state.creditDeductIdempotency.get(idempotencyKey);
    if (replay) {
      if (replay.ai_id !== aiId || replay.amount !== amount) {
        return { status: 409, body: { error: 'idempotency_conflict' } };
      }
      return {
        status: 200,
        body: {
          ai_id: replay.ai_id,
          deducted: replay.deducted,
          balance: replay.balance,
          idempotent_replay: true
        }
      };
    }
  }

  const currentBalance = state.balances.get(aiId) ?? state.defaultCredit;
  if (currentBalance < amount) {
    return {
      status: 402,
      body: {
        error: 'insufficient_credits',
        credits_needed: amount - currentBalance
      }
    };
  }

  const nextBalance = currentBalance - amount;
  state.balances.set(aiId, nextBalance);
  if (typeof idempotencyKey === 'string') {
    state.creditDeductIdempotency.set(idempotencyKey, {
      ai_id: aiId,
      amount,
      deducted: amount,
      balance: nextBalance
    });
  }

  return {
    status: 200,
    body: {
      ai_id: aiId,
      deducted: amount,
      balance: nextBalance
    }
  };
}

export function handleMockExternalApisRequest(
  request: MockExternalApisRequest,
  state: MockExternalApisState
): MockExternalApisResponse {
  const method = request.method.toUpperCase();
  const normalizedPath = request.path;

  if (method === 'GET' && normalizedPath === '/healthz') {
    return { status: 200, body: { ok: true } };
  }

  if (normalizedPath.startsWith('/owner-api/')) {
    return handleOwnerBinding({ ...request, method, path: normalizedPath }, state);
  }

  if (normalizedPath.startsWith('/credit-api/v1/balance/')) {
    return handleCreditBalance({ ...request, method, path: normalizedPath }, state);
  }

  if (normalizedPath === '/credit-api/v1/deduct') {
    return handleCreditDeduct({ ...request, method, path: normalizedPath }, state);
  }

  return { status: 404, body: { error: 'not_found' } };
}
