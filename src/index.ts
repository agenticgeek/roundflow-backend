import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import { prisma } from "./lib/prisma";
import { requireAuth } from "./middleware/requireAuth";

const app = express();

// Allow all origins for now — tighten to the frontend origin(s) later.
app.use(cors());
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Temporary protected test route: verifies the full auth chain
// (Bearer JWT → req.user → Profile lookup by supabaseUserId).
// Profile rows are auto-created by a Postgres trigger in Supabase on signup.
// Replace this with real domain routes once they exist.
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

// Centralised error handler. Must be last and take 4 args so Express treats it
// as error-handling middleware. Route handlers forward errors via next(err).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`RoundFlow backend listening on http://localhost:${PORT}`);
});

export { app };
