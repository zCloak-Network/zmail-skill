import { createHash } from 'node:crypto';
import { cacheRegisteredAgent } from '../middleware/auth.js';
import { checkOwnerBinding, OwnerBindingUnavailableError } from '../../external/ownerBinding.js';
import {
  AgentAlreadyRegisteredError,
  registerAgent,
  type AgentRecord,
  type RegisterAgentInput
} from '../../storage/agents.js';
import {
  verifyPrincipalMatchesSpki,
  verifySchnorrPubkeyMatchesSpki,
  verifySchnorrSignature
} from '../../domain/signature.js';

export interface RegisterBody {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  name?: string;
  timestamp: number;
  sig: string;
}

export interface RegisterRequest {
  body: unknown;
  ip: string;
}

export interface RegisterSuccessBody {
  ai_id: string;
  registered_at: number;
}

export interface RegisterErrorBody {
  error: 'invalid_schema'
    | 'invalid_sig'
    | 'principal_mismatch'
    | 'agent_not_bound'
    | 'already_registered'
    | 'rate_limited'
    | 'owner_api_unavailable';
  retry_after?: number;
}

export interface RegisterResponse {
  status: 201 | 400 | 403 | 409 | 429 | 503;
  body: RegisterSuccessBody | RegisterErrorBody;
}

export interface RegisterRateLimitDecision {
  allowed: boolean;
  retryAfter: number;
}

export interface RegisterRateLimiter {
  check(ip: string, aiId: string, nowUnix: number): RegisterRateLimitDecision;
}

interface WindowCounter {
  windowStart: number;
  count: number;
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const COUNTER_PRUNE_INTERVAL_SECONDS = 60;

interface CounterMutationPlan {
  allowed: boolean;
  retryAfter: number;
  next?: WindowCounter;
}

export interface InMemoryRegisterRateLimiterOptions {
  perIpPerMinute?: number;
  perAiIdPerMinute?: number;
}

export class InMemoryRegisterRateLimiter implements RegisterRateLimiter {
  private readonly perIpCounters = new Map<string, WindowCounter>();
  private readonly perAiIdCounters = new Map<string, WindowCounter>();
  private readonly perIpPerMinute: number;
  private readonly perAiIdPerMinute: number;
  private nextPruneUnix = 0;

  constructor(options: InMemoryRegisterRateLimiterOptions = {}) {
    this.perIpPerMinute = options.perIpPerMinute ?? 30;
    this.perAiIdPerMinute = options.perAiIdPerMinute ?? 5;
  }

  check(ip: string, aiId: string, nowUnix: number): RegisterRateLimitDecision {
    this.pruneStaleCounters(nowUnix);

    const aiPlan = planWindowCounterMutation(this.perAiIdCounters, aiId, nowUnix, this.perAiIdPerMinute);
    if (!aiPlan.allowed) {
      return {
        allowed: false,
        retryAfter: aiPlan.retryAfter
      };
    }

    const ipPlan = planWindowCounterMutation(this.perIpCounters, ip, nowUnix, this.perIpPerMinute);
    if (!ipPlan.allowed) {
      return {
        allowed: false,
        retryAfter: ipPlan.retryAfter
      };
    }

    commitWindowCounterMutation(this.perAiIdCounters, aiId, aiPlan);
    commitWindowCounterMutation(this.perIpCounters, ip, ipPlan);
    return { allowed: true, retryAfter: 0 };
  }

  private pruneStaleCounters(nowUnix: number): void {
    if (nowUnix < this.nextPruneUnix) {
      return;
    }
    this.nextPruneUnix = nowUnix + COUNTER_PRUNE_INTERVAL_SECONDS;
    pruneWindowCounters(this.perIpCounters, nowUnix);
    pruneWindowCounters(this.perAiIdCounters, nowUnix);
  }
}

function planWindowCounterMutation(
  counters: Map<string, WindowCounter>,
  key: string,
  nowUnix: number,
  limit: number
): CounterMutationPlan {
  const current = counters.get(key);
  if (!current || nowUnix - current.windowStart >= RATE_LIMIT_WINDOW_SECONDS) {
    return {
      allowed: true,
      retryAfter: 0,
      next: { windowStart: nowUnix, count: 1 }
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfter: Math.max(1, RATE_LIMIT_WINDOW_SECONDS - (nowUnix - current.windowStart))
    };
  }

  return {
    allowed: true,
    retryAfter: 0,
    next: {
      windowStart: current.windowStart,
      count: current.count + 1
    }
  };
}

function commitWindowCounterMutation(
  counters: Map<string, WindowCounter>,
  key: string,
  plan: CounterMutationPlan
): void {
  if (!plan.allowed || !plan.next) {
    return;
  }
  counters.set(key, plan.next);
}

function pruneWindowCounters(counters: Map<string, WindowCounter>, nowUnix: number): void {
  for (const [key, counter] of counters) {
    if (nowUnix - counter.windowStart >= RATE_LIMIT_WINDOW_SECONDS) {
      counters.delete(key);
    }
  }
}

const HEX_RE = /^[0-9a-f]+$/;

function isHex(value: string, expectedBytes: number): boolean {
  return value.length === expectedBytes * 2 && HEX_RE.test(value);
}

function isRegisterBody(value: unknown): value is RegisterBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const maybe = value as Partial<RegisterBody>;
  return (
    typeof maybe.ai_id === 'string'
    && maybe.ai_id.length > 0
    && typeof maybe.public_key_spki === 'string'
    && maybe.public_key_spki.length > 0
    && HEX_RE.test(maybe.public_key_spki)
    && maybe.public_key_spki.length % 2 === 0
    && typeof maybe.schnorr_pubkey === 'string'
    && isHex(maybe.schnorr_pubkey, 32)
    && (maybe.name === undefined || (typeof maybe.name === 'string' && maybe.name.length > 0))
    && Number.isInteger(maybe.timestamp)
    && typeof maybe.sig === 'string'
    && isHex(maybe.sig, 64)
  );
}

export function computeRegisterMessageHash(
  aiId: string,
  publicKeySpki: string,
  schnorrPubkey: string,
  timestamp: number
): string {
  const challenge = `register:${aiId}:${publicKeySpki}:${schnorrPubkey}:${timestamp}`;
  return createHash('sha256').update(challenge, 'utf8').digest('hex');
}

export interface RegisterDependencies {
  nowUnix?: () => number;
  ownerBindingCheck?: (aiId: string) => Promise<{ bound: boolean }>;
  registerAgentFn?: (input: RegisterAgentInput) => Promise<AgentRecord>;
  cacheAgentFn?: (agent: {
    ai_id: string;
    public_key_spki: string;
    schnorr_pubkey: string;
    registered_at: number;
  }) => void;
  rateLimiter?: RegisterRateLimiter;
}

const defaultRateLimiter = new InMemoryRegisterRateLimiter();

export async function handleRegister(
  request: RegisterRequest,
  dependencies: RegisterDependencies = {}
): Promise<RegisterResponse> {
  if (!isRegisterBody(request.body)) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const nowUnix = (dependencies.nowUnix ?? (() => Math.floor(Date.now() / 1000)))();
  const payload = request.body;

  if (!verifyPrincipalMatchesSpki(payload.ai_id, payload.public_key_spki)) {
    return { status: 400, body: { error: 'principal_mismatch' } };
  }

  if (!verifySchnorrPubkeyMatchesSpki(payload.schnorr_pubkey, payload.public_key_spki)) {
    return { status: 400, body: { error: 'principal_mismatch' } };
  }

  const msgHash = computeRegisterMessageHash(
    payload.ai_id,
    payload.public_key_spki,
    payload.schnorr_pubkey,
    payload.timestamp
  );
  if (!verifySchnorrSignature(msgHash, payload.sig, payload.schnorr_pubkey)) {
    return { status: 400, body: { error: 'invalid_sig' } };
  }

  if (Math.abs(nowUnix - payload.timestamp) > 300) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const limiter = dependencies.rateLimiter ?? defaultRateLimiter;
  const limitDecision = limiter.check(request.ip, payload.ai_id, nowUnix);
  if (!limitDecision.allowed) {
    return {
      status: 429,
      body: {
        error: 'rate_limited',
        retry_after: limitDecision.retryAfter
      }
    };
  }

  const ownerBindingCheck = dependencies.ownerBindingCheck ?? checkOwnerBinding;
  let ownerBinding: { bound: boolean };
  try {
    ownerBinding = await ownerBindingCheck(payload.ai_id);
  } catch (error) {
    if (error instanceof OwnerBindingUnavailableError) {
      return { status: 503, body: { error: 'owner_api_unavailable' } };
    }
    return { status: 503, body: { error: 'owner_api_unavailable' } };
  }

  if (!ownerBinding.bound) {
    return { status: 403, body: { error: 'agent_not_bound' } };
  }

  const registerAgentFn = dependencies.registerAgentFn ?? registerAgent;
  const cacheAgentFn = dependencies.cacheAgentFn ?? cacheRegisteredAgent;
  let record: AgentRecord;
  const registerInput: RegisterAgentInput = {
    ai_id: payload.ai_id,
    public_key_spki: payload.public_key_spki,
    schnorr_pubkey: payload.schnorr_pubkey,
    registered_at: nowUnix
  };
  if (payload.name !== undefined) {
    registerInput.name = payload.name;
  }
  try {
    record = await registerAgentFn(registerInput);
  } catch (error) {
    if (error instanceof AgentAlreadyRegisteredError) {
      return { status: 409, body: { error: 'already_registered' } };
    }
    throw error;
  }

  cacheAgentFn({
    ai_id: record.ai_id,
    public_key_spki: record.public_key_spki,
    schnorr_pubkey: record.schnorr_pubkey,
    registered_at: record.registered_at
  });

  return {
    status: 201,
    body: {
      ai_id: record.ai_id,
      registered_at: record.registered_at
    }
  };
}
