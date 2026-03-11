import type http from 'node:http';
import {
  handleMockExternalApisRequest,
  type MockExternalApisState,
  type MockExternalApisResponse
} from './service.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super('payload_too_large');
    this.name = 'PayloadTooLargeError';
  }
}

function writeJson(res: http.ServerResponse, response: MockExternalApisResponse): void {
  res.statusCode = response.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response.body));
}

function resolveMaxBodyBytes(input: number | undefined): number {
  if (typeof input === 'number' && Number.isInteger(input) && input > 0) {
    return input;
  }
  return DEFAULT_MAX_BODY_BYTES;
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

export interface MockExternalApisHttpHandlerOptions {
  maxBodyBytes?: number;
}

export function createMockExternalApisHttpHandler(
  state: MockExternalApisState,
  options: MockExternalApisHttpHandlerOptions = {}
) {
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);

  return async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    let body: unknown = undefined;
    if (method === 'POST') {
      try {
        const rawBody = await readRequestBody(req, maxBodyBytes);
        if (rawBody.trim().length > 0) {
          body = JSON.parse(rawBody);
        }
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          writeJson(res, { status: 413, body: { error: 'payload_too_large' } });
          return;
        }
        writeJson(res, { status: 400, body: { error: 'invalid_json' } });
        return;
      }
    }

    const response = handleMockExternalApisRequest(
      {
        method,
        path,
        body
      },
      state
    );
    writeJson(res, response);
  };
}
