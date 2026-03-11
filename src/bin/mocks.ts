import http from 'node:http';
import { createMockExternalApisHttpHandler } from '../mocks/http.js';
import { createMockExternalApisState } from '../mocks/service.js';

const DEFAULT_PORT = 9010;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_CREDIT = Number.MAX_SAFE_INTEGER;

type MocksMode = 'permissive' | 'strict';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_positive_int:${raw}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid_non_negative_int:${raw}`);
  }
  return parsed;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseMocksMode(raw: string | undefined): MocksMode {
  if (!raw) {
    return 'permissive';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'strict') {
    return 'strict';
  }
  return 'permissive';
}

async function main(): Promise<void> {
  const host = process.env.HOST?.trim() || DEFAULT_HOST;
  const port = parsePositiveInt(process.env.PORT ?? process.env.MOCK_API_PORT, DEFAULT_PORT);
  const maxBodyBytes = parsePositiveInt(process.env.ZMAIL_MOCKS_MAX_BODY_BYTES, 256 * 1024);
  const mode = parseMocksMode(process.env.ZMAIL_MOCKS_MODE);
  const defaultCredit = mode === 'strict'
    ? parseNonNegativeInt(process.env.DEFAULT_CREDIT, DEFAULT_CREDIT)
    : DEFAULT_CREDIT;
  const unboundAgents = mode === 'strict'
    ? parseCsv(process.env.UNBOUND_AGENTS)
    : [];

  if (
    mode === 'permissive'
    && (process.env.DEFAULT_CREDIT !== undefined || process.env.UNBOUND_AGENTS !== undefined)
  ) {
    console.warn('[mocks] ignoring DEFAULT_CREDIT/UNBOUND_AGENTS in permissive mode');
  }

  const state = createMockExternalApisState({
    defaultCredit,
    unboundAgents
  });

  const handler = createMockExternalApisHttpHandler(state, { maxBodyBytes });
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  console.log(`[mocks] listening on http://${host}:${port}`);
  console.log(`[mocks] mode=${mode} default_credit=${defaultCredit} unbound_agents=${unboundAgents.length}`);

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mocks] startup_failed ${message}`);
  process.exit(1);
});
