import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { AppError } from "./lib/app-error";
import { authRouter } from "./routes/auth";
import { invitesRouter } from "./routes/invites";
import { setupRouter } from "./routes/setup";
import { settingsRouter } from "./routes/settings";
import { customersRouter } from "./routes/customers";
import { propertiesRouter } from "./routes/properties";
import { roundsRouter } from "./routes/rounds";
import { todayRouter } from "./routes/today";
import { techniciansRouter } from "./routes/technicians";
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

// Reject TRACE globally before any router runs. Without this, TRACE hits auth
// middleware first and returns 401 instead of 405 on protected routes.
// RFC 9110 §15.5.6 requires the Allow header on 405 responses.
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD";
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "TRACE") {
    res.set("Allow", ALLOWED_METHODS);
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
