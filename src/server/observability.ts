import { randomUUID } from 'node:crypto';

export interface StructuredLogEntry {
  severity: 'INFO' | 'ERROR';
  time: string;
  service: string;
  event: string;
  [key: string]: unknown;
}

export interface StructuredLogger {
  log(entry: StructuredLogEntry): void;
}

function shouldEmitDefaultServerLogs(): boolean {
  const configured = process.env.ZMAIL_SERVER_LOGS;
  if (configured === '0') {
    return false;
  }
  if (configured === '1') {
    return true;
  }
  return process.env.VITEST !== '1';
}

function compactEntry(entry: StructuredLogEntry): StructuredLogEntry {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted as StructuredLogEntry;
}

export const defaultStructuredLogger: StructuredLogger = {
  log(entry): void {
    if (!shouldEmitDefaultServerLogs()) {
      return;
    }
    console.log(JSON.stringify(compactEntry(entry)));
  }
};

export function resolveRequestId(
  headers?: Record<string, string | undefined>,
  createRequestId: () => string = randomUUID
): string {
  const candidate = headers?.['x-request-id']?.trim() || headers?.['X-Request-Id']?.trim();
  if (candidate && candidate.length > 0) {
    return candidate;
  }
  return createRequestId();
}

export interface HttpRequestLogInput {
  service: 'api' | 'writer';
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  remoteIp?: string | undefined;
  errorCode?: string | undefined;
  exceptionName?: string | undefined;
  exceptionMessage?: string | undefined;
}

export function logHttpRequest(logger: StructuredLogger, input: HttpRequestLogInput): void {
  logger.log(compactEntry({
    severity: input.status >= 500 ? 'ERROR' : 'INFO',
    time: new Date().toISOString(),
    service: input.service,
    event: 'http_request',
    request_id: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    latency_ms: input.latencyMs,
    remote_ip: input.remoteIp,
    error_code: input.errorCode,
    exception_name: input.exceptionName,
    exception_message: input.exceptionMessage
  }));
}

export interface ServerLifecycleLogInput {
  service: 'api' | 'writer';
  host: string;
  port: number;
  event: 'startup' | 'shutdown';
  details?: Record<string, unknown>;
}

export function logServerLifecycle(logger: StructuredLogger, input: ServerLifecycleLogInput): void {
  logger.log(compactEntry({
    severity: 'INFO',
    time: new Date().toISOString(),
    service: input.service,
    event: input.event,
    host: input.host,
    port: input.port,
    ...(input.details ?? {})
  }));
}
