import { createHash } from 'node:crypto';
import { verifySchnorrSignature } from '../../domain/signature.js';

export interface OwnershipProofHeaders {
  'x-zmail-ai-id': string;
  'x-zmail-timestamp': string;
  'x-zmail-nonce': string;
  'x-zmail-signature': string;
}

export interface CachedAgent {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  registered_at: number;
}

const agentCache = new Map<string, CachedAgent>();
const nonceStore = new Map<string, Map<string, number>>();
const nonceStoreLastSeenUnix = new Map<string, number>();
let agentCacheLastRefreshUnix = 0;
let nonceStoreLastGlobalPruneUnix = 0;
let agentCacheRefreshInProgress: Promise<void> | null = null;

const OWNERSHIP_PROOF_TTL_SECONDS = 300;
const AGENT_CACHE_REFRESH_INTERVAL_SECONDS = 300;
const NONCE_STORE_GLOBAL_PRUNE_INTERVAL_SECONDS = 60;
let defaultAgentCacheSource: AgentCacheSource | null = null;
let defaultAgentCacheRefreshIntervalSeconds = AGENT_CACHE_REFRESH_INTERVAL_SECONDS;

export interface AgentCacheSource {
  listAgentsRegisteredBetween(fromInclusiveUnix: number, toInclusiveUnix: number): Promise<CachedAgent[]>;
}

export interface RefreshAgentCacheOptions {
  nowUnix?: number;
  fullReload?: boolean;
}

export interface GetAgentOptions {
  source: AgentCacheSource;
  nowUnix?: number;
  refreshIntervalSeconds?: number;
}

export interface ResolveCachedAgentOptions {
  nowUnix?: number;
}

export type OwnershipProofError =
  | 'invalid_schema'
  | 'not_owner'
  | 'unknown_sender'
  | 'clock_skew'
  | 'replay_nonce'
  | 'invalid_sig';

export interface OwnershipProofVerificationResult {
  ok: boolean;
  ai_id?: string;
  error?: OwnershipProofError;
}

type QueryPrimitive = string | number | boolean | null | undefined;
type QueryValue = QueryPrimitive | QueryPrimitive[];

export interface VerifyOwnershipProofInput {
  method: string;
  path: string;
  query?: string | URLSearchParams | Record<string, QueryValue>;
  body?: unknown;
  expectedAiId: string;
  headers: Record<string, string | undefined>;
  nowUnix?: number;
}

function cloneCachedAgent(agent: CachedAgent): CachedAgent {
  const copy: CachedAgent = {
    ai_id: agent.ai_id,
    public_key_spki: agent.public_key_spki,
    schnorr_pubkey: agent.schnorr_pubkey,
    registered_at: agent.registered_at
  };
  return copy;
}

export function cacheRegisteredAgent(agent: CachedAgent): void {
  agentCache.set(agent.ai_id, cloneCachedAgent(agent));
}

export function getCachedAgent(aiId: string): CachedAgent | null {
  const found = agentCache.get(aiId);
  return found ? cloneCachedAgent(found) : null;
}

export function configureDefaultAgentCacheSource(options: {
  source: AgentCacheSource | null;
  refreshIntervalSeconds?: number;
}): void {
  defaultAgentCacheSource = options.source;
  if (typeof options.refreshIntervalSeconds === 'number' && Number.isInteger(options.refreshIntervalSeconds)) {
    defaultAgentCacheRefreshIntervalSeconds = Math.max(1, options.refreshIntervalSeconds);
    return;
  }
  defaultAgentCacheRefreshIntervalSeconds = AGENT_CACHE_REFRESH_INTERVAL_SECONDS;
}

export function getDefaultAgentCacheSource(): AgentCacheSource | null {
  return defaultAgentCacheSource;
}

export function clearAgentCache(): void {
  agentCache.clear();
  agentCacheLastRefreshUnix = 0;
  agentCacheRefreshInProgress = null;
}

export function getAgentCacheLastRefreshUnix(): number {
  return agentCacheLastRefreshUnix;
}

function isValidCachedAgent(value: CachedAgent): boolean {
  return (
    typeof value.ai_id === 'string'
    && value.ai_id.length > 0
    && typeof value.public_key_spki === 'string'
    && value.public_key_spki.length > 0
    && typeof value.schnorr_pubkey === 'string'
    && value.schnorr_pubkey.length > 0
    && Number.isInteger(value.registered_at)
    && value.registered_at >= 0
  );
}

async function refreshAgentCacheOnce(
  source: AgentCacheSource,
  options: RefreshAgentCacheOptions
): Promise<void> {
  const refreshStart = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const fromInclusive = options.fullReload ? 0 : agentCacheLastRefreshUnix;
  const rows = await source.listAgentsRegisteredBetween(fromInclusive, refreshStart);

  for (const row of rows) {
    if (!isValidCachedAgent(row)) {
      continue;
    }
    cacheRegisteredAgent(row);
  }

  // Move watermark to captured window end to avoid missing in-flight registrations.
  agentCacheLastRefreshUnix = Math.max(agentCacheLastRefreshUnix, refreshStart);
}

export async function refreshAgentCache(
  source: AgentCacheSource,
  options: RefreshAgentCacheOptions = {}
): Promise<void> {
  const targetNowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const fullReload = options.fullReload === true;

  while (true) {
    const inFlight = agentCacheRefreshInProgress;
    if (inFlight) {
      await inFlight;
      if (!fullReload && agentCacheLastRefreshUnix >= targetNowUnix) {
        return;
      }
      continue;
    }

    if (!fullReload && agentCacheLastRefreshUnix >= targetNowUnix) {
      return;
    }

    const refreshPromise = refreshAgentCacheOnce(source, {
      nowUnix: targetNowUnix,
      fullReload
    });
    agentCacheRefreshInProgress = refreshPromise;
    try {
      await refreshPromise;
      return;
    } finally {
      if (agentCacheRefreshInProgress === refreshPromise) {
        agentCacheRefreshInProgress = null;
      }
    }
  }
}

export async function refreshDefaultAgentCache(options: RefreshAgentCacheOptions = {}): Promise<void> {
  if (!defaultAgentCacheSource) {
    return;
  }
  await refreshAgentCache(defaultAgentCacheSource, options);
}

function shouldRefreshAgentCache(nowUnix: number, refreshIntervalSeconds: number): boolean {
  if (agentCacheLastRefreshUnix === 0) {
    return true;
  }
  return nowUnix - agentCacheLastRefreshUnix >= refreshIntervalSeconds;
}

export async function getAgent(aiId: string, options: GetAgentOptions): Promise<CachedAgent | null> {
  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000);
  const refreshIntervalSeconds = options.refreshIntervalSeconds ?? AGENT_CACHE_REFRESH_INTERVAL_SECONDS;

  if (shouldRefreshAgentCache(nowUnix, refreshIntervalSeconds)) {
    await refreshAgentCache(options.source, { nowUnix });
  }

  return getCachedAgent(aiId);
}

export async function resolveCachedAgent(
  aiId: string,
  options: ResolveCachedAgentOptions = {}
): Promise<CachedAgent | null> {
  if (!defaultAgentCacheSource) {
    return getCachedAgent(aiId);
  }

  const getAgentOptions: GetAgentOptions = {
    source: defaultAgentCacheSource,
    refreshIntervalSeconds: defaultAgentCacheRefreshIntervalSeconds
  };
  if (options.nowUnix !== undefined) {
    getAgentOptions.nowUnix = options.nowUnix;
  }
  return getAgent(aiId, getAgentOptions);
}

export function clearOwnershipProofNonceStore(): void {
  nonceStore.clear();
  nonceStoreLastSeenUnix.clear();
  nonceStoreLastGlobalPruneUnix = 0;
}

export function getOwnershipProofNonceStoreStats(): { agentCount: number; nonceCount: number } {
  let nonceCount = 0;
  for (const perAgent of nonceStore.values()) {
    nonceCount += perAgent.size;
  }
  return {
    agentCount: nonceStore.size,
    nonceCount
  };
}

function toLowerCaseHeaders(headers: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function normalizeQueryEntries(query?: string | URLSearchParams | Record<string, QueryValue>): Array<[string, string]> {
  if (query === undefined) {
    return [];
  }

  const entries: Array<[string, string]> = [];

  if (typeof query === 'string') {
    const searchParams = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    for (const [key, value] of searchParams.entries()) {
      entries.push([normalizeText(key), normalizeText(value)]);
    }
    return entries;
  }

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) {
      entries.push([normalizeText(key), normalizeText(value)]);
    }
    return entries;
  }

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const nested of value) {
        if (nested === undefined || nested === null) {
          entries.push([normalizeText(key), '']);
        } else {
          entries.push([normalizeText(key), normalizeText(String(nested))]);
        }
      }
      continue;
    }

    if (value === undefined || value === null) {
      entries.push([normalizeText(key), '']);
    } else {
      entries.push([normalizeText(key), normalizeText(String(value))]);
    }
  }

  return entries;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalizeQuery(query?: string | URLSearchParams | Record<string, QueryValue>): string {
  const entries = normalizeQueryEntries(query).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyComparison = compareStrings(leftKey, rightKey);
    if (keyComparison !== 0) {
      return keyComparison;
    }
    return compareStrings(leftValue, rightValue);
  });

  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function canonicalizeJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value).sort(([left], [right]) => compareStrings(left, right));
    for (const [key, nestedValue] of entries) {
      out[normalizeText(key)] = canonicalizeJson(nestedValue);
    }
    return out;
  }

  return value;
}

function computeBodySha256(method: string, body: unknown): string {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' || body === undefined) {
    return createHash('sha256').update('', 'utf8').digest('hex');
  }

  const canonicalBody = JSON.stringify(canonicalizeJson(body));
  return createHash('sha256').update(canonicalBody, 'utf8').digest('hex');
}

function pruneExpiredNonces(aiId: string, nowUnix: number): void {
  const perAgent = nonceStore.get(aiId);
  if (!perAgent) {
    return;
  }

  for (const [nonce, timestamp] of perAgent.entries()) {
    if (nowUnix - timestamp > OWNERSHIP_PROOF_TTL_SECONDS) {
      perAgent.delete(nonce);
    }
  }

  if (perAgent.size === 0) {
    nonceStore.delete(aiId);
    nonceStoreLastSeenUnix.delete(aiId);
  } else {
    nonceStore.set(aiId, perAgent);
  }
}

function pruneInactiveNonceAgents(nowUnix: number): void {
  if (nowUnix - nonceStoreLastGlobalPruneUnix < NONCE_STORE_GLOBAL_PRUNE_INTERVAL_SECONDS) {
    return;
  }
  nonceStoreLastGlobalPruneUnix = nowUnix;

  for (const [aiId, perAgent] of nonceStore.entries()) {
    let lastSeenUnix = nonceStoreLastSeenUnix.get(aiId) ?? 0;
    if (lastSeenUnix === 0) {
      for (const timestamp of perAgent.values()) {
        if (timestamp > lastSeenUnix) {
          lastSeenUnix = timestamp;
        }
      }
    }

    if (perAgent.size === 0 || nowUnix - lastSeenUnix > OWNERSHIP_PROOF_TTL_SECONDS) {
      nonceStore.delete(aiId);
      nonceStoreLastSeenUnix.delete(aiId);
    }
  }
}

function isNonceReplayed(aiId: string, nonce: string): boolean {
  const perAgent = nonceStore.get(aiId);
  if (!perAgent) {
    return false;
  }
  return perAgent.has(nonce);
}

function markNonceUsed(aiId: string, nonce: string, nowUnix: number): void {
  const perAgent = nonceStore.get(aiId) ?? new Map<string, number>();
  perAgent.set(nonce, nowUnix);
  nonceStore.set(aiId, perAgent);
  nonceStoreLastSeenUnix.set(aiId, nowUnix);
}

export function buildOwnershipProofHash(input: {
  method: string;
  path: string;
  query?: string | URLSearchParams | Record<string, QueryValue> | undefined;
  body?: unknown | undefined;
  timestamp: string;
  nonce: string;
}): string {
  const method = input.method.toUpperCase();
  const canonicalPath = input.path;
  const canonicalQuery = canonicalizeQuery(input.query);
  const bodySha256 = computeBodySha256(method, input.body);

  const payload = `${method}\n${canonicalPath}\n${canonicalQuery}\n${bodySha256}\n${input.timestamp}\n${input.nonce}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export async function verifyOwnershipProof(
  input: VerifyOwnershipProofInput
): Promise<OwnershipProofVerificationResult> {
  const headers = toLowerCaseHeaders(input.headers);

  const aiId = headers['x-zmail-ai-id'];
  const timestampRaw = headers['x-zmail-timestamp'];
  const nonce = headers['x-zmail-nonce'];
  const signature = headers['x-zmail-signature'];

  if (!isNonEmptyString(aiId) || !isNonEmptyString(timestampRaw) || !isNonEmptyString(nonce) || !isNonEmptyString(signature)) {
    return { ok: false, error: 'invalid_schema' };
  }

  if (aiId !== input.expectedAiId) {
    return { ok: false, error: 'not_owner' };
  }

  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000);
  const cachedAgent = await resolveCachedAgent(aiId, { nowUnix });
  if (!cachedAgent) {
    return { ok: false, error: 'unknown_sender' };
  }

  const timestampUnix = Number(timestampRaw);
  if (!Number.isInteger(timestampUnix)) {
    return { ok: false, error: 'invalid_schema' };
  }

  if (Math.abs(nowUnix - timestampUnix) > OWNERSHIP_PROOF_TTL_SECONDS) {
    return { ok: false, error: 'clock_skew' };
  }

  pruneInactiveNonceAgents(nowUnix);
  pruneExpiredNonces(aiId, nowUnix);
  if (isNonceReplayed(aiId, nonce)) {
    return { ok: false, error: 'replay_nonce' };
  }

  const msgHash = buildOwnershipProofHash({
    method: input.method,
    path: input.path,
    query: input.query,
    body: input.body,
    timestamp: timestampRaw,
    nonce
  });

  if (!verifySchnorrSignature(msgHash, signature, cachedAgent.schnorr_pubkey)) {
    return { ok: false, error: 'invalid_sig' };
  }

  markNonceUsed(aiId, nonce, nowUnix);
  return { ok: true, ai_id: aiId };
}
