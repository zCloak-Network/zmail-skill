import http from 'node:http';
import {
  configureDefaultAgentCacheSource,
  refreshDefaultAgentCache
} from './middleware/auth.js';
import { handleRegister, type RegisterDependencies, type RegisterResponse } from './routes/register.js';
import { handleSend, type SendDependencies, type SendResponse } from './routes/send.js';
import { handleInbox, type InboxDependencies, type InboxResponse } from './routes/inbox.js';
import { handleSent, type SentDependencies, type SentResponse } from './routes/sent.js';
import { handleAck, type AckDependencies, type AckResponse } from './routes/ack.js';
import { toErrorResponse } from './middleware/errorHandler.js';
import {
  configureDefaultPublisherFromRuntime,
  resolvePublisherMode,
  type PubSubRuntimeConfig
} from '../pubsub/runtime.js';
import { getDefaultPublisher, setDefaultPublisher } from '../pubsub/publisher.js';
import {
  createAgentCacheSourceFromRuntime,
  createFirestoreDb,
  configureDefaultAgentStoreFromRuntime,
  configureDefaultMailboxStoreFromRuntime,
  configureDefaultRateLimitStoreFromRuntime,
  configureDefaultSendIntentStoreFromRuntime,
  resolveAgentStoreMode,
  type AgentRuntimeConfig,
  type MailboxRuntimeConfig,
  type RateLimitRuntimeConfig,
  type SendIntentRuntimeConfig
} from '../storage/runtime.js';
import type { FirestoreLike } from '../storage/firestoreMailbox.js';
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
  pushIfInvalidHttpUrl,
  pushIfInvalidNonNegativeInt,
  pushIfInvalidPort,
  pushIfInvalidPositiveInt,
  throwIfStartupIssues
} from '../server/startupValidation.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_AGENT_CACHE_FULL_RELOAD_SECONDS = 3600;

export interface ApiServerDependencies {
  register?: RegisterDependencies;
  send?: SendDependencies;
  inbox?: InboxDependencies;
  sent?: SentDependencies;
  ack?: AckDependencies;
}

export interface ApiRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  bodyText?: string;
  ip?: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface StartApiServerOptions {
  host?: string;
  port?: number;
  dependencies?: ApiServerDependencies;
  agentRuntime?: AgentRuntimeConfig;
  agentCacheRefreshIntervalSeconds?: number;
  agentCacheFullReloadIntervalSeconds?: number;
  mailboxRuntime?: MailboxRuntimeConfig;
  rateLimitRuntime?: RateLimitRuntimeConfig;
  sendIntentRuntime?: SendIntentRuntimeConfig;
  pubsubRuntime?: PubSubRuntimeConfig;
  logger?: StructuredLogger;
}

export interface StartedApiServer {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface PreparedApiRuntimeConfigs {
  agentRuntime: AgentRuntimeConfig | undefined;
  mailboxRuntime: MailboxRuntimeConfig | undefined;
  rateLimitRuntime: RateLimitRuntimeConfig | undefined;
  sendIntentRuntime: SendIntentRuntimeConfig | undefined;
}

export interface ApiRuntimePreparationInput {
  agentRuntime?: AgentRuntimeConfig | undefined;
  mailboxRuntime?: MailboxRuntimeConfig | undefined;
  rateLimitRuntime?: RateLimitRuntimeConfig | undefined;
  sendIntentRuntime?: SendIntentRuntimeConfig | undefined;
}

export interface ApiNodeHandlerOptions {
  logger?: StructuredLogger;
  createRequestId?: () => string;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

class InvalidPathEncodingError extends Error {
  constructor() {
    super('invalid_path_encoding');
    this.name = 'InvalidPathEncodingError';
  }
}

function normalizeHeaders(headers?: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!headers) {
    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function getIpFromHeadersOrFallback(
  headers: Record<string, string | undefined>,
  fallbackIp: string | undefined
): string {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const hops = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const trustedHop = hops.at(-1);
    if (trustedHop) {
      return trustedHop;
    }
  }

  return fallbackIp ?? '127.0.0.1';
}

function invalidSchemaResponse(): ApiResponse {
  return {
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: { error: 'invalid_schema' }
  };
}

function mapRouteResponse(routeResponse: RegisterResponse | SendResponse | InboxResponse | SentResponse | AckResponse): ApiResponse {
  return {
    status: routeResponse.status,
    headers: { 'content-type': 'application/json' },
    body: routeResponse.body as unknown as Record<string, unknown>
  };
}

function parseJsonBody(bodyText: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (bodyText === undefined || bodyText.trim().length === 0) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(bodyText) };
  } catch {
    return { ok: false };
  }
}

function extractAiIdPath(path: string, prefix: '/v1/inbox/' | '/v1/sent/'): string | null {
  if (!path.startsWith(prefix)) {
    return null;
  }
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) {
    return null;
  }
  try {
    return decodeURIComponent(rest);
  } catch (error) {
    if (error instanceof URIError) {
      throw new InvalidPathEncodingError();
    }
    throw error;
  }
}

function resolveAgentCacheRefreshIntervalSeconds(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const raw = process.env.ZMAIL_AGENT_CACHE_REFRESH_SECONDS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 300;
}

function resolveAgentCacheFullReloadIntervalSeconds(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const raw = process.env.ZMAIL_AGENT_CACHE_FULL_RELOAD_SECONDS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_AGENT_CACHE_FULL_RELOAD_SECONDS;
}

function resolveMailboxStoreMode(rawMode: string | undefined): 'memory' | 'file' | 'firestore' {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'file' || normalized === 'firestore') {
    return normalized;
  }
  return 'memory';
}

function resolveRateLimitStoreMode(rawMode: string | undefined): 'memory' | 'firestore' {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'firestore') {
    return normalized;
  }
  return 'memory';
}

function resolveSendIntentStoreMode(rawMode: string | undefined): 'memory' | 'firestore' {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'firestore') {
    return normalized;
  }
  return 'memory';
}

function normalizeProjectId(rawProjectId: string | undefined): string | undefined {
  const normalized = rawProjectId?.trim();
  return normalized ? normalized : undefined;
}

async function injectSharedFirestoreDb<T extends {
  firestoreDb?: FirestoreLike;
  firestoreProjectId?: string;
}>(
  config: T | undefined,
  useFirestore: boolean,
  getSharedFirestoreDb: (projectId: string | undefined) => Promise<FirestoreLike>
): Promise<T | undefined> {
  if (!useFirestore) {
    return config;
  }
  if (config?.firestoreDb) {
    return config;
  }

  const nextConfig = { ...(config ?? {}) } as T;
  nextConfig.firestoreDb = await getSharedFirestoreDb(
    normalizeProjectId(nextConfig.firestoreProjectId ?? process.env.GCLOUD_PROJECT)
  );
  return nextConfig;
}

export async function prepareApiRuntimeConfigs(
  options: ApiRuntimePreparationInput,
  createFirestoreDbFn: (projectId?: string) => Promise<FirestoreLike> = createFirestoreDb
): Promise<PreparedApiRuntimeConfigs> {
  const firestoreDbByProject = new Map<string, FirestoreLike>();
  const getSharedFirestoreDb = async (projectId: string | undefined): Promise<FirestoreLike> => {
    const key = projectId ?? '';
    const existing = firestoreDbByProject.get(key);
    if (existing) {
      return existing;
    }

    const created = await createFirestoreDbFn(projectId);
    firestoreDbByProject.set(key, created);
    return created;
  };

  const preparedAgentRuntime = await injectSharedFirestoreDb(
    options.agentRuntime,
    resolveAgentStoreMode(options.agentRuntime?.mode ?? process.env.ZMAIL_AGENT_STORE) === 'firestore',
    getSharedFirestoreDb
  );
  const preparedMailboxRuntime = await injectSharedFirestoreDb(
    options.mailboxRuntime,
    resolveMailboxStoreMode(options.mailboxRuntime?.mode ?? process.env.ZMAIL_MAILBOX_STORE) === 'firestore',
    getSharedFirestoreDb
  );
  const preparedRateLimitRuntime = await injectSharedFirestoreDb(
    options.rateLimitRuntime,
    resolveRateLimitStoreMode(options.rateLimitRuntime?.mode ?? process.env.ZMAIL_RATELIMIT_STORE) === 'firestore',
    getSharedFirestoreDb
  );
  const preparedSendIntentRuntime = await injectSharedFirestoreDb(
    options.sendIntentRuntime,
    resolveSendIntentStoreMode(options.sendIntentRuntime?.mode ?? process.env.ZMAIL_SEND_INTENT_STORE) === 'firestore',
    getSharedFirestoreDb
  );

  return {
    agentRuntime: preparedAgentRuntime,
    mailboxRuntime: preparedMailboxRuntime,
    rateLimitRuntime: preparedRateLimitRuntime,
    sendIntentRuntime: preparedSendIntentRuntime
  };
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

function shouldValidateOwnerBindingConfig(options: StartApiServerOptions): boolean {
  return options.dependencies?.register?.ownerBindingCheck === undefined
    || options.dependencies?.send?.ownerBindingCheck === undefined;
}

function shouldValidateCreditConfig(options: StartApiServerOptions): boolean {
  return options.dependencies?.send?.accountingFn === undefined
    && options.dependencies?.send?.deductCreditsFn === undefined;
}

function effectiveMailboxMode(options: StartApiServerOptions): string {
  return (options.mailboxRuntime?.mode ?? process.env.ZMAIL_MAILBOX_STORE ?? 'memory').trim().toLowerCase();
}

function effectiveAgentMode(options: StartApiServerOptions): string {
  return (options.agentRuntime?.mode ?? process.env.ZMAIL_AGENT_STORE ?? 'memory').trim().toLowerCase();
}

function effectiveRateLimitMode(options: StartApiServerOptions): string {
  return (options.rateLimitRuntime?.mode ?? process.env.ZMAIL_RATELIMIT_STORE ?? 'memory').trim().toLowerCase();
}

function effectiveSendIntentMode(options: StartApiServerOptions): string {
  return (options.sendIntentRuntime?.mode ?? process.env.ZMAIL_SEND_INTENT_STORE ?? 'memory').trim().toLowerCase();
}

function effectivePublisherMode(options: StartApiServerOptions): string {
  return (options.pubsubRuntime?.mode ?? process.env.ZMAIL_PUBLISHER_MODE ?? 'memory').trim().toLowerCase();
}

function shouldValidatePublisherConfig(options: StartApiServerOptions): boolean {
  return options.dependencies?.send?.publishEnvelopeFn === undefined
    && options.pubsubRuntime?.publisher === undefined;
}

export function validateApiStartupConfig(options: StartApiServerOptions = {}): void {
  const issues: string[] = [];

  pushIfInvalidHost('options.host', options.host, issues);
  pushIfInvalidPort('options.port', options.port, issues);
  pushIfInvalidPositiveInt('options.agentCacheRefreshIntervalSeconds', options.agentCacheRefreshIntervalSeconds, issues);
  pushIfInvalidPositiveInt('ZMAIL_API_MAX_BODY_BYTES', process.env.ZMAIL_API_MAX_BODY_BYTES, issues);
  pushIfInvalidPositiveInt('ZMAIL_AGENT_CACHE_REFRESH_SECONDS', process.env.ZMAIL_AGENT_CACHE_REFRESH_SECONDS, issues);
  pushIfInvalidPositiveInt('ZMAIL_AGENT_CACHE_FULL_RELOAD_SECONDS', process.env.ZMAIL_AGENT_CACHE_FULL_RELOAD_SECONDS, issues);

  pushIfInvalidChoice('agent store mode', effectiveAgentMode(options), ['memory', 'firestore'], issues);
  pushIfInvalidChoice('mailbox store mode', effectiveMailboxMode(options), ['memory', 'file', 'firestore'], issues);
  pushIfInvalidChoice('rate-limit store mode', effectiveRateLimitMode(options), ['memory', 'firestore'], issues);
  pushIfInvalidChoice('send-intent store mode', effectiveSendIntentMode(options), ['memory', 'firestore'], issues);
  pushIfInvalidChoice('publisher mode', effectivePublisherMode(options), ['memory', 'google_pubsub'], issues);

  if (effectiveMailboxMode(options) === 'file') {
    pushIfBlankWhenRequired(
      'mailbox file path',
      options.mailboxRuntime?.filePath ?? process.env.ZMAIL_MAILBOX_FILE_PATH,
      true,
      issues
    );
  }

  if (shouldValidatePublisherConfig(options) && resolvePublisherMode(effectivePublisherMode(options)) === 'google_pubsub') {
    pushIfBlankWhenRequired(
      'ZMAIL_PUBSUB_TOPIC',
      options.pubsubRuntime?.topicName ?? process.env.ZMAIL_PUBSUB_TOPIC,
      true,
      issues
    );
  }

  if (shouldValidateOwnerBindingConfig(options)) {
    pushIfInvalidHttpUrl('OWNER_API_BASE_URL', process.env.OWNER_API_BASE_URL, issues);
    pushIfInvalidPositiveInt('OWNER_API_TIMEOUT_MS', process.env.OWNER_API_TIMEOUT_MS, issues);
    pushIfInvalidPositiveInt('OWNER_API_MAX_ATTEMPTS', process.env.OWNER_API_MAX_ATTEMPTS, issues);
    pushIfInvalidNonNegativeInt('OWNER_API_RETRY_DELAY_MS', process.env.OWNER_API_RETRY_DELAY_MS, issues);
  }

  if (shouldValidateCreditConfig(options)) {
    pushIfInvalidHttpUrl('CREDIT_API_BASE_URL', process.env.CREDIT_API_BASE_URL, issues);
    pushIfInvalidPositiveInt('CREDIT_API_TIMEOUT_MS', process.env.CREDIT_API_TIMEOUT_MS, issues);
    pushIfInvalidPositiveInt('CREDIT_API_MAX_ATTEMPTS', process.env.CREDIT_API_MAX_ATTEMPTS, issues);
    pushIfInvalidNonNegativeInt('CREDIT_API_RETRY_DELAY_MS', process.env.CREDIT_API_RETRY_DELAY_MS, issues);
  }

  throwIfStartupIssues('api', issues);
}

export function createApiDispatcher(dependencies: ApiServerDependencies = {}) {
  return async function dispatch(request: ApiRequest): Promise<ApiResponse> {
    const method = request.method.toUpperCase();
    const requestUrl = new URL(request.url, 'http://localhost');
    const path = requestUrl.pathname;
    const headers = normalizeHeaders(request.headers);

    try {
      if (method === 'POST' && path === '/v1/register') {
        const parsed = parseJsonBody(request.bodyText);
        if (!parsed.ok) {
          return invalidSchemaResponse();
        }

        const routeResponse = await handleRegister(
          {
            body: parsed.value,
            ip: getIpFromHeadersOrFallback(headers, request.ip)
          },
          dependencies.register
        );
        return mapRouteResponse(routeResponse);
      }

      if (method === 'POST' && path === '/v1/send') {
        const parsed = parseJsonBody(request.bodyText);
        if (!parsed.ok) {
          return invalidSchemaResponse();
        }

        const routeResponse = await handleSend(
          {
            body: parsed.value
          },
          dependencies.send
        );
        return mapRouteResponse(routeResponse);
      }

      const inboxAiId = extractAiIdPath(path, '/v1/inbox/');
      if (method === 'GET' && inboxAiId) {
        const routeResponse = await handleInbox(
          {
            aiId: inboxAiId,
            path,
            query: requestUrl.searchParams,
            headers
          },
          dependencies.inbox
        );
        return mapRouteResponse(routeResponse);
      }

      const sentAiId = extractAiIdPath(path, '/v1/sent/');
      if (method === 'GET' && sentAiId) {
        const routeResponse = await handleSent(
          {
            aiId: sentAiId,
            path,
            query: requestUrl.searchParams,
            headers
          },
          dependencies.sent
        );
        return mapRouteResponse(routeResponse);
      }

      if (method === 'POST' && path === '/v1/ack') {
        const parsed = parseJsonBody(request.bodyText);
        if (!parsed.ok) {
          return invalidSchemaResponse();
        }

        const routeResponse = await handleAck(
          {
            path,
            body: parsed.value,
            headers
          },
          dependencies.ack
        );
        return mapRouteResponse(routeResponse);
      }

      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: { error: 'not_found' }
      };
    } catch (error) {
      if (error instanceof InvalidPathEncodingError) {
        return invalidSchemaResponse();
      }
      const mapped = toErrorResponse(error);
      return {
        status: mapped.status,
        headers: { 'content-type': 'application/json' },
        body: mapped.body
      };
    }
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

export function createApiNodeHandler(dependencies: ApiServerDependencies = {}, options: ApiNodeHandlerOptions = {}) {
  const dispatch = createApiDispatcher(dependencies);
  const maxBodyBytes = resolveMaxBodyBytes(process.env.ZMAIL_API_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
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
    let response: ApiResponse = {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { error: 'internal_error' }
    };
    let unhandledError: Error | undefined;
    let closeConnectionAfterResponse = false;

    try {
      const bodyText = await readRequestBody(req, maxBodyBytes);

      const dispatchRequest: ApiRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: normalizedHeaders,
        bodyText
      };
      if (req.socket.remoteAddress) {
        dispatchRequest.ip = req.socket.remoteAddress;
      }

      response = await dispatch(dispatchRequest);
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
      service: 'api',
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

export async function startApiServer(options: StartApiServerOptions = {}): Promise<StartedApiServer> {
  validateApiStartupConfig(options);
  const preparedRuntimeConfigs = await prepareApiRuntimeConfigs({
    agentRuntime: options.agentRuntime,
    mailboxRuntime: options.mailboxRuntime,
    rateLimitRuntime: options.rateLimitRuntime,
    sendIntentRuntime: options.sendIntentRuntime
  });

  if (
    options.agentRuntime
    || process.env.ZMAIL_AGENT_STORE
  ) {
    await configureDefaultAgentStoreFromRuntime(preparedRuntimeConfigs.agentRuntime);
  }

  const agentCacheRefreshIntervalSeconds = resolveAgentCacheRefreshIntervalSeconds(
    options.agentCacheRefreshIntervalSeconds
  );
  const agentCacheFullReloadIntervalSeconds = resolveAgentCacheFullReloadIntervalSeconds(
    options.agentCacheFullReloadIntervalSeconds
  );
  const agentCacheSource = await createAgentCacheSourceFromRuntime(preparedRuntimeConfigs.agentRuntime);
  let agentCacheRefreshTimer: NodeJS.Timeout | null = null;
  let agentCacheRefreshInProgress: Promise<void> | null = null;
  let lastAgentCacheFullReloadUnix = 0;
  const runGuardedAgentCacheRefresh = async (
    refreshOptions: { fullReload?: boolean } = {},
    swallowErrors = false
  ): Promise<void> => {
    const inProgress = agentCacheRefreshInProgress;
    if (inProgress) {
      if (swallowErrors) {
        await inProgress.catch(() => {});
        return;
      }
      await inProgress;
      return;
    }

    const requestedFullReload = refreshOptions.fullReload === true;
    const task = refreshDefaultAgentCache(refreshOptions);
    agentCacheRefreshInProgress = task;
    try {
      if (swallowErrors) {
        await task.catch(() => {});
      } else {
        await task;
      }
      if (requestedFullReload) {
        lastAgentCacheFullReloadUnix = Math.floor(Date.now() / 1000);
      }
    } finally {
      if (agentCacheRefreshInProgress === task) {
        agentCacheRefreshInProgress = null;
      }
    }
  };

  if (agentCacheSource) {
    configureDefaultAgentCacheSource({
      source: agentCacheSource,
      refreshIntervalSeconds: agentCacheRefreshIntervalSeconds
    });
    await runGuardedAgentCacheRefresh({ fullReload: true });
    agentCacheRefreshTimer = setInterval(() => {
      const nowUnix = Math.floor(Date.now() / 1000);
      const shouldFullReload = nowUnix - lastAgentCacheFullReloadUnix >= agentCacheFullReloadIntervalSeconds;
      if (shouldFullReload) {
        void runGuardedAgentCacheRefresh({ fullReload: true }, true);
        return;
      }
      void runGuardedAgentCacheRefresh({}, true);
    }, agentCacheRefreshIntervalSeconds * 1000);
  } else {
    configureDefaultAgentCacheSource({ source: null });
  }

  if (
    options.mailboxRuntime
    || process.env.ZMAIL_MAILBOX_STORE
    || process.env.ZMAIL_MAILBOX_FILE_PATH
  ) {
    await configureDefaultMailboxStoreFromRuntime(preparedRuntimeConfigs.mailboxRuntime);
  }

  if (
    options.rateLimitRuntime
    || process.env.ZMAIL_RATELIMIT_STORE
  ) {
    await configureDefaultRateLimitStoreFromRuntime(preparedRuntimeConfigs.rateLimitRuntime);
  }

  if (
    options.sendIntentRuntime
    || process.env.ZMAIL_SEND_INTENT_STORE
  ) {
    await configureDefaultSendIntentStoreFromRuntime(preparedRuntimeConfigs.sendIntentRuntime);
  }

  const shouldConfigurePublisher = options.dependencies?.send?.publishEnvelopeFn === undefined
    && (options.pubsubRuntime !== undefined || process.env.ZMAIL_PUBLISHER_MODE !== undefined);
  const previousPublisher = getDefaultPublisher();
  if (shouldConfigurePublisher) {
    await configureDefaultPublisherFromRuntime(options.pubsubRuntime);
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;
  const logger = options.logger ?? defaultStructuredLogger;
  const nodeHandler = createApiNodeHandler(options.dependencies, { logger });
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
    service: 'api',
    event: 'startup',
    host,
    port,
    details: {
      agent_store_mode: effectiveAgentMode(options),
      mailbox_store_mode: effectiveMailboxMode(options),
      ratelimit_store_mode: effectiveRateLimitMode(options),
      send_intent_store_mode: effectiveSendIntentMode(options),
      publisher_mode: effectivePublisherMode(options),
      max_body_bytes: resolveMaxBodyBytes(process.env.ZMAIL_API_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
      agent_cache_refresh_interval_seconds: agentCacheRefreshIntervalSeconds,
      agent_cache_full_reload_interval_seconds: agentCacheFullReloadIntervalSeconds
    }
  });

  return {
    server,
    host,
    port,
    close: async () => {
      if (agentCacheRefreshTimer) {
        clearInterval(agentCacheRefreshTimer);
        agentCacheRefreshTimer = null;
      }
      if (shouldConfigurePublisher) {
        setDefaultPublisher(previousPublisher);
      }
      configureDefaultAgentCacheSource({ source: null });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (inFlightHandlers.size > 0) {
        await Promise.allSettled([...inFlightHandlers]);
      }
      logServerLifecycle(logger, {
        service: 'api',
        event: 'shutdown',
        host,
        port
      });
    }
  };
}
