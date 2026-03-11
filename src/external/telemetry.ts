export type ExternalAdapterClient = 'owner_binding' | 'credits';

export interface ExternalAdapterTelemetryEvent {
  client: ExternalAdapterClient;
  ai_id: string;
  action: 'retry' | 'fail';
  reason: string;
  attempt: number;
  max_attempts: number;
  status?: number;
  next_delay_ms?: number;
}

type ExternalAdapterMetricsSink = 'off' | 'cloud_logging';

function resolveMetricsSink(raw: string | undefined): ExternalAdapterMetricsSink {
  if (!raw) {
    return 'off';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'cloud_logging') {
    return 'cloud_logging';
  }
  return 'off';
}

function toCloudLoggingPayload(event: ExternalAdapterTelemetryEvent): Record<string, unknown> {
  return {
    severity: event.action === 'fail' ? 'WARNING' : 'INFO',
    category: 'external_adapter_retry',
    component: 'zmail_api',
    timestamp: new Date().toISOString(),
    ...event
  };
}

export function emitExternalAdapterTelemetry(event: ExternalAdapterTelemetryEvent): void {
  const sink = resolveMetricsSink(process.env.ZMAIL_EXTERNAL_ADAPTER_METRICS_SINK);
  if (sink === 'off') {
    return;
  }

  if (sink === 'cloud_logging') {
    // Cloud Run forwards stdout JSON to Cloud Logging where log-based metrics can match on fields.
    console.log(JSON.stringify(toCloudLoggingPayload(event)));
  }
}
