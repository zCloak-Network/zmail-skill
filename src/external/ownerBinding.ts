import { emitExternalAdapterTelemetry } from './telemetry.js';

export interface OwnerBindingResult {
  bound: boolean;
  owner: string | null;
  tier: string | null;
}

export interface OwnerBindingOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  onRetryEvent?: (event: OwnerBindingRetryEvent) => void;
  logRetryEvents?: boolean;
}

export class OwnerBindingUnavailableError extends Error {
  constructor() {
    super('owner_api_unavailable');
    this.name = 'OwnerBindingUnavailableError';
  }
}

export type OwnerBindingRetryReason =
  | 'network_error'
  | 'status_5xx'
  | 'status_non_retryable'
  | 'invalid_json'
  | 'invalid_payload';

export interface OwnerBindingRetryEvent {
  client: 'owner_binding';
  ai_id: string;
  action: 'retry' | 'fail';
  reason: OwnerBindingRetryReason;
  attempt: number;
  max_attempts: number;
  status?: number;
  next_delay_ms?: number;
}

function getOwnerBindingUrl(baseUrl: string, aiId: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const encodedAiId = encodeURIComponent(aiId);
  return `${normalizedBase}/owner-api/v1/agents/${encodedAiId}/binding`;
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
  event: OwnerBindingRetryEvent,
  onRetryEvent: ((event: OwnerBindingRetryEvent) => void) | undefined,
  shouldLog: boolean
): void {
  emitExternalAdapterTelemetry(event);
  if (onRetryEvent) {
    onRetryEvent(event);
  }
  if (shouldLog) {
    console.warn(`[owner_binding] ${JSON.stringify(event)}`);
  }
}

export async function checkOwnerBinding(
  aiId: string,
  options: OwnerBindingOptions = {}
): Promise<OwnerBindingResult> {
  const baseUrl = options.baseUrl ?? process.env.OWNER_API_BASE_URL ?? 'http://127.0.0.1:9010';
  const timeoutMs = resolvePositiveInt(options.timeoutMs, resolvePositiveInt(readEnvInt('OWNER_API_TIMEOUT_MS'), 1500));
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = resolvePositiveInt(options.maxAttempts, resolvePositiveInt(readEnvInt('OWNER_API_MAX_ATTEMPTS'), 3));
  const retryDelayMs = resolveNonNegativeInt(options.retryDelayMs, resolveNonNegativeInt(readEnvInt('OWNER_API_RETRY_DELAY_MS'), 100));
  const sleepFn = options.sleepFn ?? defaultSleep;
  const onRetryEvent = options.onRetryEvent;
  const logRetryEvents = shouldLogRetryEvents(options.logRetryEvents);
  const url = getOwnerBindingUrl(baseUrl, aiId);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal
      });
    } catch {
      if (attempt < maxAttempts) {
        const nextDelayMs = retryDelayMs * (2 ** (attempt - 1));
        emitRetryEvent(
          {
            client: 'owner_binding',
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
          client: 'owner_binding',
          ai_id: aiId,
          action: 'fail',
          reason: 'network_error',
          attempt,
          max_attempts: maxAttempts
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new OwnerBindingUnavailableError();
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < maxAttempts) {
        const nextDelayMs = retryDelayMs * (2 ** (attempt - 1));
        emitRetryEvent(
          {
            client: 'owner_binding',
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
          client: 'owner_binding',
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
      throw new OwnerBindingUnavailableError();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      emitRetryEvent(
        {
          client: 'owner_binding',
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
      throw new OwnerBindingUnavailableError();
    }

    const bound = typeof (payload as { bound?: unknown }).bound === 'boolean'
      ? (payload as { bound: boolean }).bound
      : null;
    if (bound === null) {
      emitRetryEvent(
        {
          client: 'owner_binding',
          ai_id: aiId,
          action: 'fail',
          reason: 'invalid_payload',
          attempt,
          max_attempts: maxAttempts,
          status: response.status
        },
        onRetryEvent,
        logRetryEvents
      );
      throw new OwnerBindingUnavailableError();
    }

    const owner = typeof (payload as { owner?: unknown }).owner === 'string'
      ? (payload as { owner: string }).owner
      : null;
    const tier = typeof (payload as { tier?: unknown }).tier === 'string'
      ? (payload as { tier: string }).tier
      : null;

    return { bound, owner, tier };
  }

  throw new OwnerBindingUnavailableError();
}
