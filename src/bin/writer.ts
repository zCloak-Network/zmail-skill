import { defaultStructuredLogger } from '../server/observability.js';
import { startWriterServer } from '../writer/server.js';

function resolveHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host && host.length > 0 ? host : '0.0.0.0';
}

function resolvePort(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('invalid_port');
  }
  return parsed;
}

async function main(): Promise<void> {
  const host = resolveHost(process.env.HOST);
  const port = resolvePort(process.env.PORT, 8081);
  const started = await startWriterServer({ host, port });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    defaultStructuredLogger.log({
      severity: 'INFO',
      time: new Date().toISOString(),
      service: 'writer',
      event: 'signal',
      signal
    });
    try {
      await started.close();
      process.exitCode = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      defaultStructuredLogger.log({
        severity: 'ERROR',
        time: new Date().toISOString(),
        service: 'writer',
        event: 'shutdown_error',
        error_message: message
      });
      process.exitCode = 1;
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown_error';
  const stack = error instanceof Error ? error.stack : undefined;
  defaultStructuredLogger.log({
    severity: 'ERROR',
    time: new Date().toISOString(),
    service: 'writer',
    event: 'startup_error',
    error_message: message,
    error_stack: stack
  });
  process.exit(1);
});
