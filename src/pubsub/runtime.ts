import {
  GooglePubSubPublisher,
  getInMemorySubscriberPublisher,
  setDefaultPublisher,
  type GooglePubSubClientLike,
  type Publisher
} from './publisher.js';

export type PublisherMode = 'memory' | 'google_pubsub';

export interface PubSubRuntimeConfig {
  mode?: string;
  projectId?: string;
  topicName?: string;
  pubSubClient?: GooglePubSubClientLike;
  publisher?: Publisher;
}

export function resolvePublisherMode(rawMode: string | undefined): PublisherMode {
  const normalized = (rawMode ?? 'memory').trim().toLowerCase();
  if (normalized === 'google_pubsub') {
    return normalized;
  }
  return 'memory';
}

export async function createPubSubClient(projectId?: string): Promise<GooglePubSubClientLike> {
  const pubsubModule = await import('@google-cloud/pubsub');
  const normalizedProjectId = projectId?.trim();
  if (normalizedProjectId && normalizedProjectId.length > 0) {
    return new pubsubModule.PubSub({ projectId: normalizedProjectId }) as unknown as GooglePubSubClientLike;
  }
  return new pubsubModule.PubSub() as unknown as GooglePubSubClientLike;
}

function resolveTopicName(explicitTopicName: string | undefined): string {
  const topicName = (explicitTopicName ?? process.env.ZMAIL_PUBSUB_TOPIC ?? '').trim();
  if (!topicName) {
    throw new Error('missing_pubsub_topic');
  }
  return topicName;
}

function resolveProjectId(explicitProjectId: string | undefined): string | undefined {
  const resolved = explicitProjectId ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  const normalized = resolved?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export async function createPublisherFromRuntime(
  config: PubSubRuntimeConfig = {},
  createPubSubClientFn: (projectId?: string) => Promise<GooglePubSubClientLike> = createPubSubClient
): Promise<Publisher> {
  if (config.publisher) {
    return config.publisher;
  }

  const mode = resolvePublisherMode(config.mode ?? process.env.ZMAIL_PUBLISHER_MODE);
  if (mode === 'memory') {
    return getInMemorySubscriberPublisher();
  }

  const client = config.pubSubClient ?? await createPubSubClientFn(resolveProjectId(config.projectId));
  return new GooglePubSubPublisher(client, resolveTopicName(config.topicName));
}

export async function configureDefaultPublisherFromRuntime(
  config: PubSubRuntimeConfig = {},
  createPubSubClientFn: (projectId?: string) => Promise<GooglePubSubClientLike> = createPubSubClient
): Promise<Publisher> {
  const publisher = await createPublisherFromRuntime(config, createPubSubClientFn);
  setDefaultPublisher(publisher);
  return publisher;
}
