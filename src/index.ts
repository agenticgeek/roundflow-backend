import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { AppError } from "./lib/app-error";
import { Prisma } from "@prisma/client";
import { authRouter } from "./routes/auth";
import { invitesRouter } from "./routes/invites";
import { setupRouter } from "./routes/setup";
import { settingsRouter } from "./routes/settings";
import { customersRouter } from "./routes/customers";
import { propertiesRouter } from "./routes/properties";
import { roundsRouter } from "./routes/rounds";
import { todayRouter } from "./routes/today";
import { techniciansRouter } from "./routes/technicians";
import { invoicesRouter } from "./routes/invoices";
import { debtRouter } from "./routes/debt";
import { reportsRouter } from "./routes/reports";
import { visitsRouter } from "./routes/visits";
import { complaintsRouter } from "./routes/complaints";
import { openApiDocument } from "./swagger";
import { migrateAllTenantSchemas } from "./lib/tenant-provisioning";

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  console.error("FATAL: FRONTEND_URL env var is required");
  process.exit(1);
}
const ALLOWED_ORIGINS = FRONTEND_URL.split(",").map((u) => u.trim());

if (!process.env.INVITE_BASE_URL) {
  console.error("FATAL: INVITE_BASE_URL env var is required");
  process.exit(1);
}

const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// ── Method guards ────────────────────────────────────────────────────────────
// Two layers so auth middleware never sees a request with an unsupported method:
//
//  1. Global: block every non-standard method (TRACE, QUERY, PROPFIND, …) that
//     isn't even in the HTTP spec we support. RFC 9110 §15.5.6 requires Allow.
//  2. Per-path: for standard methods that are valid globally but not defined on
//     a specific path (e.g. PUT /complaints), derive the allow-list from the
//     OpenAPI spec and return 405 before auth middleware can respond with 401.

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD";
const ALLOWED_METHODS_SET = new Set(ALLOWED_METHODS.split(", "));

// Layer 1 — unknown/non-standard methods
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!ALLOWED_METHODS_SET.has(req.method)) {
    res.set("Allow", ALLOWED_METHODS);
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  next();
});

// Layer 2 — valid method but not defined for this specific path.
// Build a sorted map from the OpenAPI spec (most-specific paths first so
// /complaints/{id}/messages is checked before /complaints/{id}).
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const pathMethodMap: Array<{ pattern: RegExp; allow: string }> = Object.entries(
  (openApiDocument.paths ?? {}) as Record<string, Record<string, unknown>>
)
  .filter(([p]) => !p.startsWith("/auth/v1/")) // Supabase-hosted, not our server
  .sort(([a], [b]) => b.split("/").length - a.split("/").length) // deeper paths first
  .map(([path, item]) => {
    const methods = Object.keys(item)
      .filter((k) => HTTP_METHODS.has(k))
      .map((m) => m.toUpperCase());
    // OpenAPI {param} → regex segment
    const pattern = new RegExp("^" + path.replace(/\{[^}]+\}/g, "[^/]+") + "$");
    return { pattern, allow: methods.join(", ") };
  });

app.use((req: Request, res: Response, next: NextFunction) => {
  const entry = pathMethodMap.find(({ pattern }) => pattern.test(req.path));
  if (entry && !entry.allow.split(", ").includes(req.method)) {
    res.set("Allow", entry.allow);
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/auth", authRouter);
app.use("/invites", invitesRouter);
app.use("/setup", setupRouter);
app.use("/settings", settingsRouter);
app.use("/customers", customersRouter);
app.use("/properties", propertiesRouter);
app.use("/rounds", roundsRouter);
app.use("/today", todayRouter);
app.use("/technicians", techniciansRouter);
app.use("/invoices", invoicesRouter);
app.use("/debt", debtRouter);
app.use("/reports", reportsRouter);
app.use("/visits", visitsRouter);
app.use("/complaints", complaintsRouter);

// API docs (public) — interactive UI at /docs, raw spec at /openapi.json.
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(openApiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

// 405 handler — must be after all routes so unmatched methods on known paths return 405
// instead of Express's default 404. Schemathesis and RFC 7231 both expect 405 here.
app.use((_req: Request, res: Response) => {
  res.set("Allow", ALLOWED_METHODS);
  res.status(405).json({ error: "Method Not Allowed" });
});

// Centralised error handler. Must be last and take 4 args so Express treats it
// as error-handling middleware. Route handlers forward errors via next(err).
// Typed AppErrors carry their own status + message; anything else is a 500.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
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
});

const PORT = Number(process.env.PORT) || 3000;

migrateAllTenantSchemas()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`RoundFlow backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("FATAL: tenant migration failed —", err);
    process.exit(1);
  });

export { app };
