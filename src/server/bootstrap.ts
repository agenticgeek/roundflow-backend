import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import cron from "node-cron";
import { authRouter } from "../routes/auth";
import { invitesRouter } from "../routes/invites";
import { setupRouter } from "../routes/setup";
import { settingsRouter } from "../routes/settings";
import { kpiThresholdsRouter } from "../routes/kpi-thresholds";
import { customersRouter } from "../routes/customers";
import { propertiesRouter } from "../routes/properties";
import { servicePlansRouter } from "../routes/service-plans";
import { roundsRouter } from "../routes/rounds";
import { todayRouter } from "../routes/today";
import { techniciansRouter } from "../routes/technicians";
import { technicianIncidentsRouter } from "../routes/technician-incidents";
import { invoicesRouter } from "../routes/invoices";
import { messagesRouter } from "../routes/messages";
import { debtRouter } from "../routes/debt";
import { reportsRouter } from "../routes/reports";
import { visitsRouter } from "../routes/visits";
import { complaintsRouter } from "../routes/complaints";
import { dashboardRouter } from "../routes/dashboard";
import { emergenciesRouter } from "../routes/emergencies";
import { paymentsRouter } from "../routes/payments";
import { stripeWebhookRouter } from "../routes/stripeWebhook";
import { gocardlessWebhookRouter } from "../routes/gocardlessWebhook";
import { ghlWebhookRouter } from "../routes/ghlWebhook";
import { mobileRouter } from "../mobile";
import { openApiDocument } from "../swagger";
import { errorHandler } from "../lib/error-handler";
import { listMissingIntegrationEnv } from "../lib/env-check";
import { migrateAllTenantSchemas } from "../lib/tenant-provisioning";
import { runVisitGeneration } from "../jobs/visitGeneration";
import { runOutboxWorker } from "../jobs/outboxWorker";
import { runGeocodeBackfill } from "../jobs/geocodeBackfill";
import { runPreCleanReminders, isPreCleanRemindersEnabled } from "../jobs/preCleanReminders";
import { runKpiThresholdCheck } from "../jobs/kpiThresholds";
import { runIdempotencyPurge } from "../jobs/idempotencyPurge";

// App construction, cron wiring and startup sequencing, kept out of
// src/index.ts so they can be tested without binding a port, running tenant
// migrations or touching the database.

export const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD";
const ALLOWED_METHODS_SET = new Set(ALLOWED_METHODS.split(", "));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export interface PathMethodEntry {
  path: string;
  pattern: RegExp;
  allow: string;
}

/** Per-path allow-list derived from OpenAPI `paths`, deepest paths first so
 *  /complaints/{id}/messages is matched before /complaints/{id}. Supabase-hosted
 *  /auth/v1/* paths are skipped (not served by this server). */
export function buildPathMethodMap(paths: Record<string, Record<string, unknown>>): PathMethodEntry[] {
  return Object.entries(paths)
    .filter(([p]) => !p.startsWith("/auth/v1/"))
    .sort(([a], [b]) => b.split("/").length - a.split("/").length)
    .map(([path, item]) => {
      const methods = Object.keys(item)
        .filter((k) => HTTP_METHODS.has(k))
        .map((m) => m.toUpperCase());
      // OpenAPI {param} → regex segment
      const pattern = new RegExp("^" + path.replace(/\{[^}]+\}/g, "[^/]+") + "$");
      return { path, pattern, allow: methods.join(", ") };
    });
}

/** The entry that blocks `method` on `path` (→ 405), or undefined when allowed. */
export function findBlockingEntry(map: PathMethodEntry[], method: string, path: string): PathMethodEntry | undefined {
  const entry = map.find(({ pattern }) => pattern.test(path));
  return entry && !entry.allow.split(", ").includes(method) ? entry : undefined;
}

/** Shared readiness flag: false until tenant migrations have finished (GAP-005). */
export interface Readiness {
  ready: boolean;
}

export interface CreateAppOptions {
  allowedOrigins: string[];
  readiness: Readiness;
}

export function createApp({ allowedOrigins, readiness }: CreateAppOptions): Express {
  const app = express();

  app.use(cors({ origin: allowedOrigins, credentials: true }));

  // Stripe webhook must receive the raw body for signature verification.
  // Must be mounted BEFORE express.json() which would parse and discard it.
  app.use("/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookRouter);
  app.use("/webhooks/gocardless", express.raw({ type: "application/json" }), gocardlessWebhookRouter);
  app.use("/webhooks/ghl", express.raw({ type: "application/json" }), ghlWebhookRouter);

  app.use(express.json());

  // ── Method guards ──────────────────────────────────────────────────────────
  // Two layers so auth middleware never sees a request with an unsupported method:
  //  1. Global: block every non-standard method (TRACE, QUERY, PROPFIND, …).
  //     RFC 9110 §15.5.6 requires Allow.
  //  2. Per-path: for standard methods not defined on a specific path (e.g.
  //     PUT /complaints), derive the allow-list from the OpenAPI spec and
  //     return 405 before auth middleware can respond with 401.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!ALLOWED_METHODS_SET.has(req.method)) {
      res.set("Allow", ALLOWED_METHODS);
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    next();
  });

  const pathMethodMap = buildPathMethodMap(openApiDocument.paths as Record<string, Record<string, unknown>>);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const blocking = findBlockingEntry(pathMethodMap, req.method, req.path);
    if (blocking) {
      res.set("Allow", blocking.allow);
      return res.status(405).json({ error: "Method Not Allowed" });
    }
    next();
  });

  // GAP-005: the server listens while tenant migrations run, so health checks
  // answer 503 "migrating" until they finish.
  app.get("/health", (_req: Request, res: Response) => {
    if (!readiness.ready) return res.status(503).json({ status: "migrating" });
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
  app.get("/health/ready", (_req: Request, res: Response) => {
    if (!readiness.ready) return res.status(503).json({ status: "migrating" });
    res.json({ status: "ready" });
  });

  app.use("/auth", authRouter);
  app.use("/invites", invitesRouter);
  app.use("/setup", setupRouter);
  // Before /settings: settingsRouter would otherwise see /settings/kpi-thresholds first.
  app.use("/settings/kpi-thresholds", kpiThresholdsRouter);
  app.use("/settings", settingsRouter);
  app.use("/customers", customersRouter);
  app.use("/properties", propertiesRouter);
  app.use("/service-plans", servicePlansRouter);
  app.use("/rounds", roundsRouter);
  app.use("/today", todayRouter);
  app.use("/technicians", techniciansRouter);
  app.use("/technician-incidents", technicianIncidentsRouter);
  app.use("/invoices", invoicesRouter);
  app.use("/messages", messagesRouter);
  app.use("/debt", debtRouter);
  app.use("/reports", reportsRouter);
  app.use("/visits", visitsRouter);
  app.use("/complaints", complaintsRouter);
  app.use("/dashboard", dashboardRouter);
  app.use("/emergencies", emergenciesRouter);
  app.use("/payments", paymentsRouter);
  app.use("/mobile", mobileRouter);

  // API docs (public) — interactive UI at /docs, raw spec at /openapi.json.
  app.get("/openapi.json", (_req: Request, res: Response) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  // 405 handler — after all routes so unmatched methods on known paths return
  // 405 instead of Express's default 404 (Schemathesis / RFC 7231).
  app.use((_req: Request, res: Response) => {
    res.set("Allow", ALLOWED_METHODS);
    res.status(405).json({ error: "Method Not Allowed" });
  });

  app.use(errorHandler);
  return app;
}

type ScheduleFn = (expression: string, task: () => void) => unknown;

function guarded(label: string, job: () => Promise<unknown>): () => void {
  return () => {
    job().catch((err) => console.error(`[${label}] run failed:`, err));
  };
}

/** Registers every cron job; returns the labels registered (for logs/tests). */
export function registerCronJobs(schedule: ScheduleFn = cron.schedule, env: NodeJS.ProcessEnv = process.env): string[] {
  const jobs: Array<[string, string, () => Promise<unknown>]> = [
    // Nightly at 01:00 UTC — generate next-cycle visits for all active rounds
    ["visitGen", "0 1 * * *", runVisitGeneration],
    // Every 30s — drain GHL outbox
    ["outbox", "*/30 * * * * *", runOutboxWorker],
    // Every 15 min — geocode any property still missing latitude/longitude
    ["geocodeBackfill", "*/15 * * * *", runGeocodeBackfill],
    // Nightly at 02:00 UTC — KPI threshold alerts (B6)
    ["kpiThresholds", "0 2 * * *", () => runKpiThresholdCheck()],
    // Nightly at 03:00 UTC — purge mobile idempotency records past their TTL
    ["idempotencyPurge", "0 3 * * *", () => runIdempotencyPurge()],
  ];
  // Every 15 min — pre-clean reminders (B2), opt-in per deployment
  if (isPreCleanRemindersEnabled(env)) {
    jobs.push(["preCleanReminders", "*/15 * * * *", () => runPreCleanReminders()]);
  }
  for (const [label, expression, job] of jobs) schedule(expression, guarded(label, job));
  return jobs.map(([label]) => label);
}

export interface StartServerDeps {
  allowedOrigins: string[];
  port: number;
  env?: NodeJS.ProcessEnv;
  migrate?: () => Promise<unknown>;
  schedule?: ScheduleFn;
  exit?: (code: number) => void;
  listen?: (app: Express, port: number, onListening: () => void) => unknown;
}

/** Listen first (health → 503 "migrating"), then migrate tenant schemas, then
 *  mark ready and start cron. A migration failure exits the process with 1. */
export async function startServer(deps: StartServerDeps): Promise<{ app: Express; readiness: Readiness }> {
  const env = deps.env ?? process.env;
  const missing = listMissingIntegrationEnv(env);
  if (missing.length > 0) {
    console.warn(`[startup] missing integration env vars (those integrations will not work): ${missing.join(", ")}`);
  }

  const readiness: Readiness = { ready: false };
  const app = createApp({ allowedOrigins: deps.allowedOrigins, readiness });
  const listen = deps.listen ?? ((a: Express, port: number, cb: () => void) => a.listen(port, cb));
  listen(app, deps.port, () => {
    console.log(`RoundFlow backend listening on http://localhost:${deps.port}`);
  });

  try {
    await (deps.migrate ?? migrateAllTenantSchemas)();
  } catch (err) {
    console.error("FATAL: tenant migration failed —", err);
    (deps.exit ?? process.exit)(1);
    return { app, readiness };
  }
  readiness.ready = true;
  registerCronJobs(deps.schedule ?? cron.schedule, env);
  return { app, readiness };
}
