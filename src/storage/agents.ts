export interface AgentRecord {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  name?: string;
  registered_at: number;
}

export interface RegisterAgentInput {
  ai_id: string;
  public_key_spki: string;
  schnorr_pubkey: string;
  name?: string;
  registered_at: number;
}

export class AgentAlreadyRegisteredError extends Error {
  readonly aiId: string;

  constructor(aiId: string) {
    super('already_registered');
    this.name = 'AgentAlreadyRegisteredError';
    this.aiId = aiId;
  }
}

export interface AgentStore {
  registerAgent(input: RegisterAgentInput): Promise<AgentRecord>;
  getAgent(aiId: string): Promise<AgentRecord | null>;
  isBlocked(recipientAiId: string, senderAiId: string): Promise<boolean>;
  clear(): void;
}

function cloneAgent(agent: AgentRecord): AgentRecord {
  const copy: AgentRecord = {
    ai_id: agent.ai_id,
    public_key_spki: agent.public_key_spki,
    schnorr_pubkey: agent.schnorr_pubkey,
    registered_at: agent.registered_at
  };
  if (agent.name !== undefined) {
    copy.name = agent.name;
  }
  return copy;
}

export class InMemoryAgentStore implements AgentStore {
  private readonly records = new Map<string, AgentRecord>();
  private readonly blockedByRecipient = new Map<string, Set<string>>();

  async registerAgent(input: RegisterAgentInput): Promise<AgentRecord> {
    if (this.records.has(input.ai_id)) {
      throw new AgentAlreadyRegisteredError(input.ai_id);
    }

    const record: AgentRecord = {
      ai_id: input.ai_id,
      public_key_spki: input.public_key_spki,
      schnorr_pubkey: input.schnorr_pubkey,
      registered_at: input.registered_at
    };
    if (input.name !== undefined) {
      record.name = input.name;
    }

    this.records.set(input.ai_id, record);
    return cloneAgent(record);
  }

  async getAgent(aiId: string): Promise<AgentRecord | null> {
    const found = this.records.get(aiId);
    return found ? cloneAgent(found) : null;
  }

  async isBlocked(recipientAiId: string, senderAiId: string): Promise<boolean> {
    return this.blockedByRecipient.get(recipientAiId)?.has(senderAiId) ?? false;
  }

  blockAgent(recipientAiId: string, senderAiId: string): void {
    const blocked = this.blockedByRecipient.get(recipientAiId) ?? new Set<string>();
    blocked.add(senderAiId);
    this.blockedByRecipient.set(recipientAiId, blocked);
  }

  clear(): void {
    this.records.clear();
    this.blockedByRecipient.clear();
  }
}

let defaultStore: AgentStore = new InMemoryAgentStore();

export function getDefaultAgentStore(): AgentStore {
  return defaultStore;
}

export function setDefaultAgentStore(store: AgentStore): void {
  defaultStore = store;
}

export function clearDefaultAgentStore(): void {
  defaultStore.clear();
}

export async function registerAgent(input: RegisterAgentInput, store: AgentStore = defaultStore): Promise<AgentRecord> {
  return store.registerAgent(input);
}

export async function getAgent(aiId: string, store: AgentStore = defaultStore): Promise<AgentRecord | null> {
  return store.getAgent(aiId);
}

export async function isSenderBlockedByRecipient(
  recipientAiId: string,
  senderAiId: string,
  store: AgentStore = defaultStore
): Promise<boolean> {
  return store.isBlocked(recipientAiId, senderAiId);
}
