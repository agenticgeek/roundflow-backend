// Typed application error. Services throw this with an HTTP status code; the
// centralised error handler in src/index.ts maps it to `{ error: message }` with
// that status (plus `code` when one is set, for clients that need to branch on
// the reason without matching message text). Anything that isn't an AppError is
// treated as an unexpected 500.
/** One field-level problem in a validation error: `path` is the dotted body/query key. */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 400 with per-field detail: `{ error, code: "VALIDATION_FAILED", fields: [{ path, code, message }] }` (BE-13). */
export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly fields: FieldError[],
    code = "VALIDATION_FAILED"
  ) {
    super(400, message, code);
    this.name = "ValidationError";
  }
}
