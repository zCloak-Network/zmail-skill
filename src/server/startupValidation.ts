export class StartupConfigError extends Error {
  readonly issues: string[];

  constructor(service: string, issues: string[]) {
    super(`[${service}] invalid startup config: ${issues.join('; ')}`);
    this.name = 'StartupConfigError';
    this.issues = [...issues];
  }
}

function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function toTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function pushIfInvalidHost(name: string, value: string | undefined, issues: string[]): void {
  if (value === undefined) {
    return;
  }
  if (value.trim().length === 0) {
    issues.push(`${name} must be a non-empty string`);
  }
}

export function pushIfInvalidPort(name: string, value: number | undefined, issues: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    issues.push(`${name} must be an integer between 1 and 65535`);
  }
}

export function pushIfInvalidChoice(
  name: string,
  value: string | undefined,
  allowed: readonly string[],
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    issues.push(`${name} must be one of: ${allowed.join(', ')}`);
  }
}

export function pushIfInvalidPositiveInt(
  name: string,
  value: number | string | undefined,
  issues: string[]
): void {
  if (!isProvided(value)) {
    return;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push(`${name} must be a positive integer`);
  }
}

export function pushIfInvalidNonNegativeInt(
  name: string,
  value: number | string | undefined,
  issues: string[]
): void {
  if (!isProvided(value)) {
    return;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    issues.push(`${name} must be a non-negative integer`);
  }
}

export function pushIfInvalidHttpUrl(name: string, value: string | undefined, issues: string[]): void {
  const trimmed = toTrimmedString(value);
  if (!trimmed) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    issues.push(`${name} must be a valid absolute http(s) URL`);
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push(`${name} must use http or https`);
  }
}

export function pushIfBlankWhenRequired(
  name: string,
  value: string | undefined,
  required: boolean,
  issues: string[]
): void {
  if (!required) {
    return;
  }
  if (!value || value.trim().length === 0) {
    issues.push(`${name} is required`);
  }
}

export function throwIfStartupIssues(service: string, issues: string[]): void {
  if (issues.length > 0) {
    throw new StartupConfigError(service, issues);
  }
}
