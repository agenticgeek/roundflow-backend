// Typed application error. Services throw this with an HTTP status code; the
// centralised error handler in src/index.ts maps it to `{ error: message }` with
// that status (plus `code` when one is set, for clients that need to branch on
// the reason without matching message text). Anything that isn't an AppError is
// treated as an unexpected 500.
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
