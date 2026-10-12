export class SboxError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "SboxError";
  }
}
export class APIError extends SboxError {
  constructor(code: string, message: string, status = 500, details?: unknown) {
    super(code, message, status, details);
    this.name = "APIError";
  }
}
export function invariant(
  value: unknown,
  code: string,
  message: string,
  status = 400,
): asserts value {
  if (!value) throw new SboxError(code, message, status);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
