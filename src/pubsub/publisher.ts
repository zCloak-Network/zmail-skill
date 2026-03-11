import type { Kind17Envelope } from '../domain/envelope.js';

export type PublishMessageType = 'inbox' | 'sent';

export interface PublishEnvelopeInput {
  msg_id: string;
  type: PublishMessageType;
  from: string;
  sender_public_key_spki: string;
  sender_schnorr_pubkey: string;
  to: string;
  received_at: number;
  envelope: Kind17Envelope;
}

export interface Publisher {
  publish(input: PublishEnvelopeInput): Promise<void>;
}

export interface GooglePubSubPublishMessage {
  data: Buffer;
  attributes?: Record<string, string> | undefined;
}

export interface GooglePubSubTopicLike {
  publishMessage(message: GooglePubSubPublishMessage): Promise<string>;
}

export interface GooglePubSubClientLike {
  topic(name: string): GooglePubSubTopicLike;
}

export interface PubSubPushEnvelope {
  message: {
    data: string;
    attributes: {
      msg_id: string;
      type: PublishMessageType;
      from: string;
      sender_public_key_spki: string;
      sender_schnorr_pubkey: string;
      to: string;
      received_at: string;
    };
    messageId: string;
  };
}

export type PublishSubscriber = (pushEnvelope: PubSubPushEnvelope) => Promise<void>;

function clonePublishEnvelopeInput(input: PublishEnvelopeInput): PublishEnvelopeInput {
  const copy: PublishEnvelopeInput = {
    msg_id: input.msg_id,
    type: input.type,
    from: input.from,
    sender_public_key_spki: input.sender_public_key_spki,
    sender_schnorr_pubkey: input.sender_schnorr_pubkey,
    to: input.to,
    received_at: input.received_at,
    envelope: input.envelope
  };
  return copy;
}

function buildPushAttributes(input: PublishEnvelopeInput): PubSubPushEnvelope['message']['attributes'] {
  const attributes: PubSubPushEnvelope['message']['attributes'] = {
    msg_id: input.msg_id,
    type: input.type,
    from: input.from,
    sender_public_key_spki: input.sender_public_key_spki,
    sender_schnorr_pubkey: input.sender_schnorr_pubkey,
    to: input.to,
    received_at: String(input.received_at)
  };
  return attributes;
}

export class InMemoryPublisher implements Publisher {
  private readonly messages: PublishEnvelopeInput[] = [];

  async publish(input: PublishEnvelopeInput): Promise<void> {
    this.messages.push(clonePublishEnvelopeInput(input));
  }

  getPublished(): PublishEnvelopeInput[] {
    return this.messages.map((message) => clonePublishEnvelopeInput(message));
  }

  clear(): void {
    this.messages.length = 0;
  }
}

export class GooglePubSubPublisher implements Publisher {
  private readonly topic: GooglePubSubTopicLike;

  constructor(topicOrClient: GooglePubSubTopicLike | GooglePubSubClientLike, topicName?: string) {
    if (topicName) {
      this.topic = (topicOrClient as GooglePubSubClientLike).topic(topicName);
      return;
    }
    this.topic = topicOrClient as GooglePubSubTopicLike;
  }

  async publish(input: PublishEnvelopeInput): Promise<void> {
    await this.topic.publishMessage({
      data: Buffer.from(JSON.stringify(input.envelope), 'utf8'),
      attributes: buildPushAttributes(input)
    });
  }
}

let publishSequence = 0;
const publishSubscribers = new Set<PublishSubscriber>();

function nextMessageId(): string {
  publishSequence += 1;
  return `inmem-${publishSequence}`;
}

export function toPubSubPushEnvelope(input: PublishEnvelopeInput, messageId: string = nextMessageId()): PubSubPushEnvelope {
  return {
    message: {
      data: Buffer.from(JSON.stringify(input.envelope), 'utf8').toString('base64'),
      attributes: buildPushAttributes(input),
      messageId
    }
  };
}

const inMemorySubscriberPublisher: Publisher = {
  async publish(input): Promise<void> {
    if (publishSubscribers.size === 0) {
      return;
    }

    const pushEnvelope = toPubSubPushEnvelope(input);
    for (const subscriber of publishSubscribers) {
      await subscriber(pushEnvelope);
    }
  }
};

let defaultPublisher: Publisher = inMemorySubscriberPublisher;

export function subscribeToPublishedMessages(subscriber: PublishSubscriber): () => void {
  publishSubscribers.add(subscriber);
  return () => {
    publishSubscribers.delete(subscriber);
  };
}

export function clearPublishedMessageSubscribers(): void {
  publishSubscribers.clear();
}

export function resetPublishedMessageSequence(): void {
  publishSequence = 0;
}

export function getInMemorySubscriberPublisher(): Publisher {
  return inMemorySubscriberPublisher;
}

export function getDefaultPublisher(): Publisher {
  return defaultPublisher;
}

export function setDefaultPublisher(publisher: Publisher): void {
  defaultPublisher = publisher;
}

export function resetDefaultPublisher(): void {
  defaultPublisher = inMemorySubscriberPublisher;
}

export async function publishEnvelope(
  input: PublishEnvelopeInput,
  publisher: Publisher = defaultPublisher
): Promise<void> {
  await publisher.publish(input);
}
