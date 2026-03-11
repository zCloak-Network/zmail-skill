import { verifyOwnershipProof, type VerifyOwnershipProofInput } from '../middleware/auth.js';
import { ackInboxMessages } from '../../storage/inbox.js';

const MAX_ACK_MSG_IDS = 100;

export interface AckBody {
  ai_id: string;
  msg_ids: string[];
}

export interface AckRequest {
  path: string;
  body: unknown;
  headers: Record<string, string | undefined>;
}

export type AckResponse =
  | { status: 200; body: { acked: number } }
  | { status: 400; body: { error: 'invalid_schema' } }
  | { status: 403; body: { error: 'not_owner' } };

export interface AckDependencies {
  nowUnix?: () => number;
  verifyOwnershipProofFn?: (input: VerifyOwnershipProofInput) => Promise<{ ok: boolean }>;
  ackInboxMessagesFn?: (aiId: string, msgIds: string[]) => Promise<number>;
}

function isAckBody(value: unknown): value is AckBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const maybe = value as Partial<AckBody>;
  if (typeof maybe.ai_id !== 'string' || maybe.ai_id.length === 0) {
    return false;
  }
  if (!Array.isArray(maybe.msg_ids)) {
    return false;
  }
  if (maybe.msg_ids.length > MAX_ACK_MSG_IDS) {
    return false;
  }
  if (maybe.msg_ids.some((msgId) => typeof msgId !== 'string' || msgId.length === 0)) {
    return false;
  }
  return true;
}

export async function handleAck(
  request: AckRequest,
  dependencies: AckDependencies = {}
): Promise<AckResponse> {
  if (!isAckBody(request.body)) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const verifyOwnershipProofFn = dependencies.verifyOwnershipProofFn ?? verifyOwnershipProof;
  const ownershipInput: VerifyOwnershipProofInput = {
    method: 'POST',
    path: request.path,
    body: request.body,
    expectedAiId: request.body.ai_id,
    headers: request.headers
  };
  if (dependencies.nowUnix) {
    ownershipInput.nowUnix = dependencies.nowUnix();
  }

  const ownership = await verifyOwnershipProofFn(ownershipInput);
  if (!ownership.ok) {
    return { status: 403, body: { error: 'not_owner' } };
  }

  const ackFn = dependencies.ackInboxMessagesFn ?? ackInboxMessages;
  const acked = await ackFn(request.body.ai_id, request.body.msg_ids);

  return {
    status: 200,
    body: { acked }
  };
}
