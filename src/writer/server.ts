import http from 'node:http';
import { subscribeToPublishedMessages } from '../pubsub/publisher.js';
import { handlePubSubPush, type WriterHandlerDependencies, type WriterPushResponse } from './handler.js';
import {
  configureDefaultMailboxStoreFromRuntime,
  type MailboxRuntimeConfig
} from '../storage/runtime.js';
import {
  defaultStructuredLogger,
  logHttpRequest,
  logServerLifecycle,
  resolveRequestId,
  type StructuredLogger
} from '../server/observability.js';
import {
  pushIfBlankWhenRequired,
  pushIfInvalidChoice,
  pushIfInvalidHost,
  pushIfInvalidPort,
  pushIfInvalidPositiveInt,
  throwIfStartupIssues
} from '../server/startupValidation.js';

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_PUSH_AUTH_MODE: WriterPushAuthMode = 'oidc';

export interface WriterRequest {
  method: string;
  url: string;
  bodyText?: string;
  headers?: Record<string, string | undefined>;
}

export interface WriterResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface StartWriterServerOptions {
  host?: string;
  port?: number;
  handlerDependencies?: WriterHandlerDependencies;
  mailboxRuntime?: MailboxRuntimeConfig;
  auth?: WriterPushAuthConfig;
  logger?: StructuredLogger;
}

export interface StartedWriterServer {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

export type WriterPushAuthMode = 'off' | 'oidc';

export interface VerifyOidcTokenInput {
  token: string;
  audience: string;
  expectedEmail: string | undefined;
}

export type VerifyOidcTokenFn = (input: VerifyOidcTokenInput) => Promise<boolean>;

export interface WriterPushAuthConfig {
  mode?: string;
  oidcAudience?: string;
  oidcEmail?: string;
  verifyOidcTokenFn?: VerifyOidcTokenFn;
}

export interface WriterNodeHandlerOptions {
  logger?: StructuredLogger;
  createRequestId?: () => string;
}

let defaultOidcVerifierClient: {
  verifyIdToken(input: { idToken: string; audience: string }): Promise<{ getPayload(): Record<string, unknown> | undefined }>;
} | undefined;

async function getDefaultOidcVerifierClient() {
  if (defaultOidcVerifierClient) {
    return defaultOidcVerifierClient;
  }

  const authModule = await import('google-auth-library');
  defaultOidcVerifierClient = new authModule.OAuth2Client() as unknown as {
    verifyIdToken(input: {
      idToken: string;
      audience: string;
    }): Promise<{ getPayload(): { email?: string; email_verified?: boolean } | undefined }>;
  };
  return defaultOidcVerifierClient;
}

async function defaultVerifyOidcToken(input: VerifyOidcTokenInput): Promise<boolean> {
  const client = await getDefaultOidcVerifierClient();
  const ticket = await client.verifyIdToken({
    idToken: input.token,
    audience: input.audience
  });
  const payload = ticket.getPayload();
  if (!payload) {
    return false;
  }

  if (!input.expectedEmail) {
    return true;
  }

  return payload.email === input.expectedEmail && payload.email_verified === true;
}

function parseWriterPushAuthMode(raw: string | undefined): WriterPushAuthMode {
  const normalized = (raw ?? DEFAULT_PUSH_AUTH_MODE).trim().toLowerCase();
  if (normalized === 'off' || normalized === 'oidc') {
    return normalized;
  }
  return DEFAULT_PUSH_AUTH_MODE;
}

interface ResolvedWriterPushAuthConfig {
  mode: WriterPushAuthMode;
  oidcAudience: string | undefined;
  oidcEmail: string | undefined;
  verifyOidcTokenFn: VerifyOidcTokenFn;
}

function resolveWriterPushAuthConfig(config: WriterPushAuthConfig = {}): ResolvedWriterPushAuthConfig {
  const mode = parseWriterPushAuthMode(config.mode ?? process.env.ZMAIL_WRITER_PUSH_AUTH_MODE);
  const oidcAudience = config.oidcAudience ?? process.env.ZMAIL_WRITER_PUSH_OIDC_AUDIENCE;
  const oidcEmail = config.oidcEmail ?? process.env.ZMAIL_WRITER_PUSH_OIDC_EMAIL;
  return {
    mode,
    oidcAudience,
    oidcEmail,
    verifyOidcTokenFn: config.verifyOidcTokenFn ?? defaultVerifyOidcToken
  };
}

function extractBearerToken(headers: Record<string, string | undefined> | undefined): string | null {
  if (!headers) {
    return null;
  }
  const authorization = headers.authorization ?? headers.Authorization;
  if (!authorization) {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return null;
  }
  return match[1];
}

function mapWriterResponse(routeResponse: WriterPushResponse): WriterResponse {
  return {
    status: routeResponse.status,
    headers: { 'content-type': 'application/json' },
    body: routeResponse.body as unknown as Record<string, unknown>
  };
}

function parseJsonBody(bodyText: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!bodyText || bodyText.trim().length === 0) {
    return { ok: false };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(bodyText)
    };
  } catch {
    return { ok: false };
  }
}

function resolveMaxBodyBytes(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getIpFromHeadersOrFallback(
  headers: Record<string, string | undefined>,
  fallbackIp: string | undefined
): string | undefined {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }

  return fallbackIp;
}

function effectiveWriterMailboxMode(options: StartWriterServerOptions): string {
  return (options.mailboxRuntime?.mode ?? process.env.ZMAIL_MAILBOX_STORE ?? 'memory').trim().toLowerCase();
}

function effectiveWriterPushAuthMode(options: StartWriterServerOptions): string {
  return (options.auth?.mode ?? process.env.ZMAIL_WRITER_PUSH_AUTH_MODE ?? DEFAULT_PUSH_AUTH_MODE).trim().toLowerCase();
}

export function validateWriterStartupConfig(options: StartWriterServerOptions = {}): void {
  const issues: string[] = [];

  pushIfInvalidHost('options.host', options.host, issues);
  pushIfInvalidPort('options.port', options.port, issues);
  pushIfInvalidPositiveInt('ZMAIL_WRITER_MAX_BODY_BYTES', process.env.ZMAIL_WRITER_MAX_BODY_BYTES, issues);
  pushIfInvalidChoice('mailbox store mode', effectiveWriterMailboxMode(options), ['memory', 'file', 'firestore'], issues);
  pushIfInvalidChoice('writer push auth mode', effectiveWriterPushAuthMode(options), ['off', 'oidc'], issues);

  if (effectiveWriterMailboxMode(options) === 'file') {
    pushIfBlankWhenRequired(
      'mailbox file path',
      options.mailboxRuntime?.filePath ?? process.env.ZMAIL_MAILBOX_FILE_PATH,
      true,
      issues
    );
  }

  pushIfBlankWhenRequired(
    'ZMAIL_WRITER_PUSH_OIDC_AUDIENCE',
    options.auth?.oidcAudience ?? process.env.ZMAIL_WRITER_PUSH_OIDC_AUDIENCE,
    effectiveWriterPushAuthMode(options) === 'oidc',
    issues
  );

  throwIfStartupIssues('writer', issues);
}

export function createWriterDispatcher(
  handlerDependencies: WriterHandlerDependencies = {},
  authConfig: WriterPushAuthConfig = {}
) {
  const resolvedAuth = resolveWriterPushAuthConfig(authConfig);

  return async function dispatch(request: WriterRequest): Promise<WriterResponse> {
    const method = request.method.toUpperCase();
    const url = new URL(request.url, 'http://localhost');

    if (method === 'POST' && url.pathname === '/') {
      if (resolvedAuth.mode === 'oidc') {
        if (!resolvedAuth.oidcAudience || resolvedAuth.oidcAudience.trim().length === 0) {
          return {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: { error: 'writer_auth_misconfigured' }
          };
        }

        const token = extractBearerToken(request.headers);
        if (!token) {
          return {
            status: 401,
            headers: { 'content-type': 'application/json' },
            body: { error: 'unauthorized' }
          };
        }

        let verified = false;
        try {
          verified = await resolvedAuth.verifyOidcTokenFn({
            token,
            audience: resolvedAuth.oidcAudience,
            expectedEmail: resolvedAuth.oidcEmail
          });
        } catch {
          verified = false;
        }

        if (!verified) {
          return {
            status: 401,
            headers: { 'content-type': 'application/json' },
            body: { error: 'unauthorized' }
          };
        }
      }

      const parsed = parseJsonBody(request.bodyText);
      if (!parsed.ok) {
        return {
          status: 400,
          headers: { 'content-type': 'application/json' },
          body: { error: 'invalid_pubsub_message' }
        };
      }

      const routeResponse = await handlePubSubPush(
        { body: parsed.value },
        handlerDependencies
      );
      return mapWriterResponse(routeResponse);
    }

    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: { error: 'not_found' }
    };
  };
}

async function readRequestBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<string> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createWriterNodeHandler(
  handlerDependencies: WriterHandlerDependencies = {},
  authConfig: WriterPushAuthConfig = {},
  options: WriterNodeHandlerOptions = {}
) {
  const dispatch = createWriterDispatcher(handlerDependencies, authConfig);
  const maxBodyBytes = resolveMaxBodyBytes(process.env.ZMAIL_WRITER_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const logger = options.logger ?? defaultStructuredLogger;

  return async function nodeHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const normalizedHeaders: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        normalizedHeaders[key] = value.join(',');
      } else {
        normalizedHeaders[key] = value;
      }
    }

    const requestId = resolveRequestId(normalizedHeaders, options.createRequestId);
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const remoteIp = getIpFromHeadersOrFallback(normalizedHeaders, req.socket.remoteAddress);
    const startedAtMs = Date.now();
    let response: WriterResponse = {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: 'internal_error' }
    };
    let unhandledError: Error | undefined;
    let closeConnectionAfterResponse = false;

    try {
      const bodyText = await readRequestBody(req, maxBodyBytes);

      response = await dispatch({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        bodyText,
        headers: normalizedHeaders
      });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        closeConnectionAfterResponse = true;
        response = {
          status: 413,
          headers: {
            'content-type': 'application/json',
            connection: 'close'
          },
          body: { error: 'payload_too_large' }
        };
      } else {
        unhandledError = error instanceof Error ? error : new Error('unknown_error');
        response = {
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: { error: 'internal_error' }
        };
      }
    }

    if (closeConnectionAfterResponse) {
      res.shouldKeepAlive = false;
      res.once('finish', () => {
        if (!req.destroyed) {
          req.destroy();
        }
      });
    }

    res.statusCode = response.status;
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
    res.setHeader('x-request-id', requestId);
    res.end(JSON.stringify(response.body));

    const errorCode = typeof response.body.error === 'string' ? response.body.error : undefined;
    logHttpRequest(logger, {
      service: 'writer',
      requestId,
      method: req.method ?? 'GET',
      path: requestUrl.pathname,
      status: response.status,
      latencyMs: Math.max(0, Date.now() - startedAtMs),
      remoteIp,
      errorCode,
      exceptionName: unhandledError?.name,
      exceptionMessage: unhandledError?.message
    });
  };
}

export function connectWriterToPublishedMessages(handlerDependencies: WriterHandlerDependencies = {}): () => void {
  return subscribeToPublishedMessages(async (pushEnvelope) => {
    await handlePubSubPush({ body: pushEnvelope }, handlerDependencies);
  });
}

export async function startWriterServer(options: StartWriterServerOptions = {}): Promise<StartedWriterServer> {
  validateWriterStartupConfig(options);
  if (
    options.mailboxRuntime
    || process.env.ZMAIL_MAILBOX_STORE
    || process.env.ZMAIL_MAILBOX_FILE_PATH
  ) {
    await configureDefaultMailboxStoreFromRuntime(options.mailboxRuntime);
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8081;
  const logger = options.logger ?? defaultStructuredLogger;
  const nodeHandler = createWriterNodeHandler(options.handlerDependencies, options.auth, { logger });
  const inFlightHandlers = new Set<Promise<void>>();
  const server = http.createServer((req, res) => {
    const task = nodeHandler(req, res);
    inFlightHandlers.add(task);
    task.then(
      () => {
        inFlightHandlers.delete(task);
      },
      () => {
        inFlightHandlers.delete(task);
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  logServerLifecycle(logger, {
    service: 'writer',
    event: 'startup',
    host,
    port,
    details: {
      mailbox_store_mode: effectiveWriterMailboxMode(options),
      push_auth_mode: effectiveWriterPushAuthMode(options),
      max_body_bytes: resolveMaxBodyBytes(process.env.ZMAIL_WRITER_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES)
    }
  });

  return {
    server,
    host,
    port,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          logServerLifecycle(logger, {
            service: 'writer',
            event: 'shutdown',
            host,
            port
          });
          Promise.allSettled([...inFlightHandlers]).then(() => resolve(), reject);
        });
      })
  };
}
