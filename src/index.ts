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
import { openApiDocument } from "./swagger";

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

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/auth", authRouter);
app.use("/invites", invitesRouter);
app.use("/setup", setupRouter);
app.use("/settings", settingsRouter);
app.use("/customers", customersRouter);
app.use("/properties", propertiesRouter);

// API docs (public) — interactive UI at /docs, raw spec at /openapi.json.
app.get("/openapi.json", (_req: Request, res: Response) => {
  res.json(openApiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

// Centralised error handler. Must be last and take 4 args so Express treats it
// as error-handling middleware. Route handlers forward errors via next(err).
// Typed AppErrors carry their own status + message; anything else is a 500.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`RoundFlow backend listening on http://localhost:${PORT}`);
});

export { app };
