import { verifyOwnershipProof, type VerifyOwnershipProofInput } from '../middleware/auth.js';
import {
  listInboxMessages,
  type InboxQuery,
  type InboxQueryResult
} from '../../storage/inbox.js';

export interface InboxRequest {
  aiId: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
}

export type InboxResponse =
  | { status: 200; body: InboxQueryResult }
  | { status: 400; body: { error: 'invalid_schema' } }
  | { status: 403; body: { error: 'not_owner' } };

export interface InboxDependencies {
  nowUnix?: () => number;
  verifyOwnershipProofFn?: (input: VerifyOwnershipProofInput) => Promise<{ ok: boolean }>;
  listInboxMessagesFn?: (aiId: string, query: InboxQuery) => Promise<InboxQueryResult>;
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

function parseUnread(value: string | null): boolean | null | undefined {
  if (value === null || value.length === 0) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

export async function handleInbox(
  request: InboxRequest,
  dependencies: InboxDependencies = {}
): Promise<InboxResponse> {
  const limitRaw = request.query.get('limit');
  const unreadRaw = request.query.get('unread');
  const fromRaw = request.query.get('from');
  const afterRaw = request.query.get('after');

  const limit = parseLimit(limitRaw);
  if (limitRaw !== null && limit === null) {
    return { status: 400, body: { error: 'invalid_schema' } };
  }

  const unread = parseUnread(unreadRaw);
  if (unreadRaw !== null && unread === null) {
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

  const listInboxMessagesFn = dependencies.listInboxMessagesFn ?? listInboxMessages;
  const query: InboxQuery = {};
  if (typeof limit === 'number') {
    query.limit = limit;
  }
  if (afterRaw !== null && afterRaw.length > 0) {
    query.after = afterRaw;
  }
  if (unread !== undefined && unread !== null) {
    query.unread = unread;
  }
  if (fromRaw !== null && fromRaw.length > 0) {
    query.from = fromRaw;
  }

  let result: InboxQueryResult;
  try {
    result = await listInboxMessagesFn(request.aiId, query);
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
