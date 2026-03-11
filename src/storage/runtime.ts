import { FileMailboxStore } from './fileMailbox.js';
import type { FirestoreAgentCacheSource } from './firestoreAgentCacheSource.js';
import type { FirestoreLike } from './firestoreMailbox.js';
import {
  InMemoryAgentStore,
  setDefaultAgentStore,
  type AgentStore
} from './agents.js';
import {
  InMemoryMailboxStore,
  setDefaultMailboxStore,
  type MailboxStore
} from './inbox.js';
import {
  InMemoryRateLimitStateStore,
  setDefaultRateLimitStateStore,
  type RateLimitStateStore
} from './ratelimit.js';
import {
  InMemorySendIntentStore,
  setDefaultSendIntentStore,
  type SendIntentStore
} from './sendIntents.js';

export type MailboxStoreMode = 'memory' | 'file' | 'firestore';
export type RateLimitStoreMode = 'memory' | 'firestore';
export type SendIntentStoreMode = 'memory' | 'firestore';
export type AgentStoreMode = 'memory' | 'firestore';

export interface MailboxRuntimeConfig {
  mode?: string;
  filePath?: string;
  firestoreProjectId?: string;
  firestoreDb?: FirestoreLike;
}

export interface SendIntentRuntimeConfig {
  mode?: string;
  firestoreProjectId?: string;
  firestoreDb?: FirestoreLike;
}

export interface RateLimitRuntimeConfig {
  mode?: string;
  firestoreProjectId?: string;
  firestoreDb?: FirestoreLike;
}

export interface AgentRuntimeConfig {
  mode?: string;
  firestoreProjectId?: string;
  firestoreDb?: FirestoreLike;
}

function parseMode(rawMode: string | undefined): MailboxStoreMode {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'file' || normalized === 'firestore') {
    return normalized;
  }
  throw new Error(`invalid_mailbox_store_mode:${normalized}`);
}

function parseSendIntentMode(rawMode: string | undefined): SendIntentStoreMode {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'firestore') {
    return normalized;
  }
  throw new Error(`invalid_send_intent_store_mode:${normalized}`);
}

function parseRateLimitMode(rawMode: string | undefined): RateLimitStoreMode {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'firestore') {
    return normalized;
  }
  throw new Error(`invalid_ratelimit_store_mode:${normalized}`);
}

export function resolveAgentStoreMode(rawMode: string | undefined): AgentStoreMode {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'memory' || normalized === 'firestore') {
    return normalized;
  }
  throw new Error(`invalid_agent_store_mode:${normalized}`);
}

export async function createFirestoreDb(projectId?: string): Promise<FirestoreLike> {
  const firestoreModule = await import('@google-cloud/firestore');
  if (projectId && projectId.length > 0) {
    return new firestoreModule.Firestore({ projectId }) as unknown as FirestoreLike;
  }
  return new firestoreModule.Firestore() as unknown as FirestoreLike;
}

function resolveFilePath(explicitFilePath?: string): string {
  const resolved = explicitFilePath ?? process.env.ZMAIL_MAILBOX_FILE_PATH ?? '.zmail/mailbox.log';
  if (!resolved || resolved.trim().length === 0) {
    throw new Error('invalid_mailbox_file_path');
  }
  return resolved;
}

export async function createMailboxStoreFromRuntime(config: MailboxRuntimeConfig = {}): Promise<MailboxStore> {
  const mode = parseMode(config.mode ?? process.env.ZMAIL_MAILBOX_STORE);
  if (mode === 'memory') {
    return new InMemoryMailboxStore();
  }

  if (mode === 'file') {
    return new FileMailboxStore(resolveFilePath(config.filePath));
  }

  const db = config.firestoreDb ?? await createFirestoreDb(config.firestoreProjectId ?? process.env.GCLOUD_PROJECT);
  const { FirestoreMailboxStore } = await import('./firestoreMailbox.js');
  return new FirestoreMailboxStore(db);
}

export async function configureDefaultMailboxStoreFromRuntime(config: MailboxRuntimeConfig = {}): Promise<MailboxStore> {
  const store = await createMailboxStoreFromRuntime(config);
  setDefaultMailboxStore(store);
  return store;
}

export async function createSendIntentStoreFromRuntime(config: SendIntentRuntimeConfig = {}): Promise<SendIntentStore> {
  const mode = parseSendIntentMode(config.mode ?? process.env.ZMAIL_SEND_INTENT_STORE);
  if (mode === 'memory') {
    return new InMemorySendIntentStore();
  }

  const db = config.firestoreDb ?? await createFirestoreDb(config.firestoreProjectId ?? process.env.GCLOUD_PROJECT);
  const { FirestoreSendIntentStore } = await import('./firestoreSendIntents.js');
  return new FirestoreSendIntentStore(db);
}

export async function configureDefaultSendIntentStoreFromRuntime(
  config: SendIntentRuntimeConfig = {}
): Promise<SendIntentStore> {
  const store = await createSendIntentStoreFromRuntime(config);
  setDefaultSendIntentStore(store);
  return store;
}

export async function createRateLimitStoreFromRuntime(config: RateLimitRuntimeConfig = {}): Promise<RateLimitStateStore> {
  const mode = parseRateLimitMode(config.mode ?? process.env.ZMAIL_RATELIMIT_STORE);
  if (mode === 'memory') {
    return new InMemoryRateLimitStateStore();
  }

  const db = config.firestoreDb ?? await createFirestoreDb(config.firestoreProjectId ?? process.env.GCLOUD_PROJECT);
  const { FirestoreRateLimitStateStore } = await import('./firestoreRateLimit.js');
  return new FirestoreRateLimitStateStore(db);
}

export async function configureDefaultRateLimitStoreFromRuntime(
  config: RateLimitRuntimeConfig = {}
): Promise<RateLimitStateStore> {
  const store = await createRateLimitStoreFromRuntime(config);
  setDefaultRateLimitStateStore(store);
  return store;
}

export async function createAgentStoreFromRuntime(config: AgentRuntimeConfig = {}): Promise<AgentStore> {
  const mode = resolveAgentStoreMode(config.mode ?? process.env.ZMAIL_AGENT_STORE);
  if (mode === 'memory') {
    return new InMemoryAgentStore();
  }

  const db = config.firestoreDb ?? await createFirestoreDb(config.firestoreProjectId ?? process.env.GCLOUD_PROJECT);
  const { FirestoreAgentStore } = await import('./firestoreAgents.js');
  return new FirestoreAgentStore(db);
}

export async function configureDefaultAgentStoreFromRuntime(
  config: AgentRuntimeConfig = {}
): Promise<AgentStore> {
  const store = await createAgentStoreFromRuntime(config);
  setDefaultAgentStore(store);
  return store;
}

export async function createAgentCacheSourceFromRuntime(
  config: AgentRuntimeConfig = {}
): Promise<FirestoreAgentCacheSource | null> {
  const mode = resolveAgentStoreMode(config.mode ?? process.env.ZMAIL_AGENT_STORE);
  if (mode !== 'firestore') {
    return null;
  }

  const db = config.firestoreDb ?? await createFirestoreDb(config.firestoreProjectId ?? process.env.GCLOUD_PROJECT);
  const { FirestoreAgentCacheSource } = await import('./firestoreAgentCacheSource.js');
  return new FirestoreAgentCacheSource(db);
}
