function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (isRecord(error)) {
    const maybeStatus = error.status;
    const maybeBody = error.body;
    if (
      typeof maybeStatus === 'number'
      && Number.isInteger(maybeStatus)
      && maybeStatus >= 400
      && maybeStatus <= 599
      && isRecord(maybeBody)
    ) {
      return {
        status: maybeStatus,
        body: maybeBody
      };
    }
  }

  return {
    status: 500,
    body: {
      error: 'internal_error'
    }
  };
}
