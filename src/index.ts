import "dotenv/config";
import { startServer } from "./server/bootstrap";

// Thin entry point: required env checks, then src/server/bootstrap.ts builds
// the app, listens, runs tenant migrations and starts cron jobs.

const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
  console.error("FATAL: FRONTEND_URL env var is required");
  process.exit(1);
}

if (!process.env.INVITE_BASE_URL) {
  console.error("FATAL: INVITE_BASE_URL env var is required");
  process.exit(1);
}

void startServer({
  allowedOrigins: FRONTEND_URL.split(",").map((u) => u.trim()),
  port: Number(process.env.PORT) || 3000,
});
