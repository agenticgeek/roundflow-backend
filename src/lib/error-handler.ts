import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { AppError } from "./app-error";

// Own properties every AppError carries that are already represented in the
// body (status line, `error`, `code`) or must never leak (`stack`).
const RESERVED = new Set(["statusCode", "code", "name", "message", "stack"]);

/** JSON body for an AppError: `{ error, code? }` plus any extra own fields a
 *  subclass adds (e.g. AllocationError.fields, NoMatchingRoundError.suggestions
 *  / proposedName), so routes no longer hand-roll those responses. */
export function appErrorBody(err: AppError): Record<string, unknown> {
  const body: Record<string, unknown> = { error: err.message };
  if (err.code) body.code = err.code;
  for (const [key, value] of Object.entries(err)) {
    if (!RESERVED.has(key) && value !== undefined) body[key] = value;
  }
  return body;
}

// Centralised error handler. Must be last and take 4 args so Express treats it
// as error-handling middleware. Route handlers forward errors via next(err).
// Typed AppErrors carry their own status + message; anything else is a 500.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(appErrorBody(err));
  }
  // express.json() body-parser SyntaxError (invalid JSON, null bytes, non-object strict-mode
  // rejection). The middleware sets err.status=400 and err.body on the thrown SyntaxError.
  if (err instanceof SyntaxError && (err as unknown as Record<string, unknown>).status === 400) {
    return res.status(400).json({ error: "Invalid JSON in request body." });
  }
  // Prisma FK constraint violation — a referenced record still exists. Map to 409
  // so callers know the operation is blocked by a dependency, not a server bug.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
    return res.status(409).json({ error: "Cannot delete: record is referenced by other data." });
  }
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
}
