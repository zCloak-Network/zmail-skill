import { verifyOwnershipProof, type VerifyOwnershipProofInput } from '../middleware/auth.js';
import {
  listSentMessages,
  type SentQuery,
  type SentQueryResult
} from '../../storage/inbox.js';

export interface SentRequest {
  aiId: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
}

export type SentResponse =
  | { status: 200; body: SentQueryResult }
  | { status: 400; body: { error: 'invalid_schema' } }
  | { status: 403; body: { error: 'not_owner' } };

export interface SentDependencies {
  nowUnix?: () => number;
  verifyOwnershipProofFn?: (input: VerifyOwnershipProofInput) => Promise<{ ok: boolean }>;
  listSentMessagesFn?: (aiId: string, query: SentQuery) => Promise<SentQueryResult>;
}

function parseLimit(value: string | null): number | null | undefined {
  if (value === null || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, 100);
}

export async function handleSent(
  request: SentRequest,
  dependencies: SentDependencies = {}
): Promise<SentResponse> {
  const limitRaw = request.query.get('limit');
  const toRaw = request.query.get('to');
  const afterRaw = request.query.get('after');

  const limit = parseLimit(limitRaw);
  if (limitRaw !== null && limit === null) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const verifyOwnershipProofFn = dependencies.verifyOwnershipProofFn ?? verifyOwnershipProof;
  const ownershipInput: VerifyOwnershipProofInput = {
    method: 'GET',
    path: request.path,
    query: request.query,
    expectedAiId: request.aiId,
    headers: request.headers
  };
  if (dependencies.nowUnix) {
    ownershipInput.nowUnix = dependencies.nowUnix();
  }

  const ownership = await verifyOwnershipProofFn(ownershipInput);
  if (!ownership.ok) {
    return { status: 403, body: { error: 'not_owner' } };
  }

  const listSentMessagesFn = dependencies.listSentMessagesFn ?? listSentMessages;
  const query: SentQuery = {};
  if (limit !== undefined && limit !== null) {
    query.limit = limit;
  }
  if (afterRaw !== null && afterRaw.length > 0) {
    query.after = afterRaw;
  }
  if (toRaw !== null && toRaw.length > 0) {
    query.to = toRaw;
  }

  let result: SentQueryResult;
  try {
    result = await listSentMessagesFn(request.aiId, query);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_cursor') {
      return { status: 400, body: { error: 'invalid_schema' } };
    }
    throw error;
  }
  return {
    status: 200,
    body: result
  };
}
