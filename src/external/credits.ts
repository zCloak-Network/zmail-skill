import { emitExternalAdapterTelemetry } from './telemetry.js';

export interface DeductCreditsResult {
  ai_id: string;
  deducted: number;
  balance: number;
}

export interface CreditClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  onRetryEvent?: (event: CreditRetryEvent) => void;
  logRetryEvents?: boolean;
}

export class CreditApiUnavailableError extends Error {
  constructor() {
    super('credit_api_unavailable');
    this.name = 'CreditApiUnavailableError';
  }
}

export class InsufficientCreditsError extends Error {
  readonly creditsNeeded: number;

  constructor(creditsNeeded: number) {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsError';
    this.creditsNeeded = creditsNeeded;
  }
}

export type CreditRetryReason =
  | 'network_error'
  | 'status_5xx'
  | 'status_non_retryable'
  | 'insufficient_credits'
  | 'invalid_json';

export interface CreditRetryEvent {
  client: 'credits';
  ai_id: string;
  action: 'retry' | 'fail';
  reason: CreditRetryReason;
  attempt: number;
  max_attempts: number;
  status?: number;
  next_delay_ms?: number;
}

function getCreditDeductUrl(baseUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  return `${normalizedBase}/credit-api/v1/deduct`;
}

function resolvePositiveInt(input: number | undefined, fallback: number): number {
  if (typeof input === 'number' && Number.isInteger(input) && input > 0) {
    return input;
  }
  return fallback;
}

function resolveNonNegativeInt(input: number | undefined, fallback: number): number {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0) {
    return input;
  }
  return fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function readEnvInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function shouldLogRetryEvents(option: boolean | undefined): boolean {
  if (typeof option === 'boolean') {
    return option;
  }
  return process.env.ZMAIL_EXTERNAL_ADAPTER_LOG_RETRIES === '1';
}

function emitRetryEvent(
  event: CreditRetryEvent,
  onRetryEvent: ((event: CreditRetryEvent) => void) | undefined,
  shouldLog: boolean
): void {
  emitExternalAdapterTelemetry(event);
  if (onRetryEvent) {
    onRetryEvent(event);
  }
  if (shouldLog) {
    console.warn(`[credits] ${JSON.stringify(event)}`);
  }
}

export async function deductCredits(
  aiId: string,
  amount: number,
  idempotencyKey: string,
  options: CreditClientOptions = {}
): Promise<DeductCreditsResult> {
  if (!aiId || !Number.isInteger(amount) || amount < 0 || !idempotencyKey) {
    throw new Error('invalid_credit_request');
  }

  if (amount === 0) {
    return {
      ai_id: aiId,
      deducted: 0,
      balance: Number.POSITIVE_INFINITY
    };
  }

  const baseUrl = options.baseUrl ?? process.env.CREDIT_API_BASE_URL ?? 'http://127.0.0.1:9011';
  const timeoutMs = resolvePositiveInt(options.timeoutMs, resolvePositiveInt(readEnvInt('CREDIT_API_TIMEOUT_MS'), 1500));
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = resolvePositiveInt(options.maxAttempts, resolvePositiveInt(readEnvInt('CREDIT_API_MAX_ATTEMPTS'), 3));
  const retryDelayMs = resolveNonNegativeInt(options.retryDelayMs, resolveNonNegativeInt(readEnvInt('CREDIT_API_RETRY_DELAY_MS'), 100));
  const sleepFn = options.sleepFn ?? defaultSleep;
  const onRetryEvent = options.onRetryEvent;
  const logRetryEvents = shouldLogRetryEvents(options.logRetryEvents);
  const url = getCreditDeductUrl(baseUrl);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ai_id: aiId,
          amount,
          idempotency_key: idempotencyKey
        }),
        signal: controller.signal
      });
    } catch {
      if (attempt < maxAttempts) {
        const nextDelayMs = retryDelayMs * (2 ** (attempt - 1));
        emitRetryEvent(
          {
            client: 'credits',
            ai_id: aiId,
            action: 'retry',
            reason: 'network_error',
            attempt,
            max_attempts: maxAttempts,
            next_delay_ms: nextDelayMs
          },
          onRetryEvent,
          logRetryEvents
        );
        await sleepFn(nextDelayMs);
        continue;
      }
      emitRetryEvent(
        {
          client: 'credits',
          ai_id: aiId,
          action: 'fail',
          reason: 'network_error',
          attempt,
          max_attempts: maxAttempts
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new CreditApiUnavailableError();
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (response.status === 402) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        emitRetryEvent(
          {
            client: 'credits',
            ai_id: aiId,
            action: 'fail',
            reason: 'invalid_json',
            attempt,
            max_attempts: maxAttempts,
            status: response.status
          },
          onRetryEvent,
          logRetryEvents
        );
        throw new InsufficientCreditsError(amount);
      }

      const creditsNeeded = typeof (payload as { credits_needed?: unknown }).credits_needed === 'number'
        ? Math.max(0, Math.floor((payload as { credits_needed: number }).credits_needed))
        : amount;
      emitRetryEvent(
        {
          client: 'credits',
          ai_id: aiId,
          action: 'fail',
          reason: 'insufficient_credits',
          attempt,
          max_attempts: maxAttempts,
          status: response.status
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new InsufficientCreditsError(creditsNeeded);
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const nextDelayMs = retryDelayMs * (2 ** (attempt - 1));
        emitRetryEvent(
          {
            client: 'credits',
            ai_id: aiId,
            action: 'retry',
            reason: 'status_5xx',
            attempt,
            max_attempts: maxAttempts,
            status: response.status,
            next_delay_ms: nextDelayMs
          },
          onRetryEvent,
          logRetryEvents
        );
        await sleepFn(nextDelayMs);
        continue;
      }
      emitRetryEvent(
        {
          client: 'credits',
          ai_id: aiId,
          action: 'fail',
          reason: isRetryableStatus(response.status) ? 'status_5xx' : 'status_non_retryable',
          attempt,
          max_attempts: maxAttempts,
          status: response.status
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new CreditApiUnavailableError();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      emitRetryEvent(
        {
          client: 'credits',
          ai_id: aiId,
          action: 'fail',
          reason: 'invalid_json',
          attempt,
          max_attempts: maxAttempts,
          status: response.status
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new CreditApiUnavailableError();
    }

    const deducted = typeof (payload as { deducted?: unknown }).deducted === 'number'
      ? (payload as { deducted: number }).deducted
      : amount;
    const balance = typeof (payload as { balance?: unknown }).balance === 'number'
      ? (payload as { balance: number }).balance
      : 0;

    return {
      ai_id: aiId,
      deducted,
      balance
    };
  }

  throw new CreditApiUnavailableError();
}
