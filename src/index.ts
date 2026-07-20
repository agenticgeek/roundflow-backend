import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { prisma } from "./lib/prisma";
import { requireAuth } from "./middleware/requireAuth";
import { AppError } from "./lib/app-error";
import { authRouter } from "./routes/auth";
import { setupRouter } from "./routes/setup";
import { settingsRouter } from "./routes/settings";
import { customersRouter } from "./routes/customers";
import { propertiesRouter } from "./routes/properties";
import { openApiDocument } from "./swagger";

const app = express();

// Allow all origins for now — tighten to the frontend origin(s) later.
app.use(cors());
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /auth/me — returns the Profile for the authenticated user, or 404 if
// no Profile exists yet (new user who hasn't called POST /auth/signup).
// The frontend uses the 404 response to detect new users and trigger signup.
app.get(
  "/auth/me",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await prisma.profile.findUnique({
        where: { supabaseUserId: req.user!.supabaseUserId },
      });
      if (!profile) {
        return res.status(404).json({ error: "Profile not found" });
      }
      return res.json(profile);
    } catch (err) {
      next(err);
    }
  }
);

app.use("/auth", authRouter);
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
