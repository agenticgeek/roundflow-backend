import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import cron from "node-cron";
import { authRouter } from "../routes/auth";
import { invitesRouter } from "../routes/invites";
import { setupRouter } from "../routes/setup";
import { settingsRouter } from "../routes/settings";
import { settingsEmailRouter } from "../routes/settings-email";
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
import { sesWebhookRouter } from "../routes/sesWebhook";
import { chatRouter } from "../routes/chat";
import { notificationsRouter } from "../routes/notifications";
import { integrationsRouter } from "../routes/integrations";
import { floRouter } from "../routes/flo";
import { mobileRouter } from "../mobile";
import { openApiDocument } from "../swagger";
import { errorHandler } from "../lib/error-handler";
import { requestId } from "../lib/request-id";
import { createLimiter, rateLimitConfig } from "../lib/rate-limit";
import { prisma } from "../lib/prisma";
import { disconnectAllTenantClients } from "../lib/tenant-prisma-manager";
import { installGracefulShutdown } from "./shutdown";
import { listMissingIntegrationEnv, listMissingRecommendedEnv } from "../lib/env-check";
import { migrateAllTenantSchemas } from "../lib/tenant-provisioning";
import { runVisitGeneration } from "../jobs/visitGeneration";
import { runOutboxWorker } from "../jobs/outboxWorker";
import { runGeocodeBackfill } from "../jobs/geocodeBackfill";
import { runPreCleanReminders, isPreCleanRemindersEnabled } from "../jobs/preCleanReminders";
import { runKpiThresholdCheck } from "../jobs/kpiThresholds";
import { runIdempotencyPurge } from "../jobs/idempotencyPurge";
import { runWebhookRetry } from "../jobs/webhookRetry";
import { runOverdueSweep } from "../jobs/overdueSweep";
import { runEmailDomainRecheck } from "../jobs/emailDomainRecheck";
import { runFloPurge } from "../jobs/floPurge";

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
  /** BE-18: tenant schemas whose startup migration failed (count only; names are in the log). */
  failedTenantMigrations?: number;
}

export interface CreateAppOptions {
  allowedOrigins: string[];
  readiness: Readiness;
  env?: NodeJS.ProcessEnv;
  /** BE-18: readiness probe query; defaults to `SELECT 1` on the public schema. */
  pingDb?: () => Promise<unknown>;
}

/** BE-25: /docs and /openapi.json are public everywhere except production,
 *  where they stay closed unless EXPOSE_API_DOCS=true. */
export function shouldExposeApiDocs(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.EXPOSE_API_DOCS === "true";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProcessLike = { on: (event: string, listener: (...args: any[]) => void) => unknown };

/** BE-02: last-resort process handlers. An unhandled rejection is logged (the
 *  server keeps running; request handlers have their own error paths); an
 *  uncaught exception is logged and the process exits non-zero so the
 *  supervisor restarts it, rather than continuing in an unknown state. */
export function installProcessErrorHandlers(
  proc: ProcessLike = process,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    console.error("[process] unhandledRejection:", reason);
  });
  proc.on("uncaughtException", (err: Error) => {
    console.error("[process] uncaughtException:", err);
    exit(1);
  });
}

const DB_PING_TIMEOUT_MS = 3000;
const defaultPingDb = () => prisma.$queryRaw`SELECT 1`;

/** `TRUST_PROXY`: number of proxy hops in front of the app (default 1 in production, none elsewhere). */
export function trustProxySetting(env: NodeJS.ProcessEnv): number | false {
  const raw = env.TRUST_PROXY;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : false;
  }
  return env.NODE_ENV === "production" ? 1 : false;
}

export function createApp({ allowedOrigins, readiness, env = process.env, pingDb = defaultPingDb }: CreateAppOptions): Express {
  const app = express();
  app.set("trust proxy", trustProxySetting(env));

  // BE-09: request id first (every response, error bodies included), then security headers. Swagger UI needs
  // inline scripts, so /docs gets helmet without its Content-Security-Policy.
  app.use(requestId());
  const apiHelmet = helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } });
  const docsHelmet = helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } });
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith("/docs") ? docsHelmet : apiHelmet)(req, res, next));
  app.use(cors({ origin: allowedOrigins, credentials: true }));

  // BE-09: rate limits (RATE_LIMIT_* env, RATE_LIMIT_DISABLED=true to switch off). Global default for the API;
  // strict ones for the unauthenticated endpoints that cost real work (signup creates a Postgres schema).
  const limits = rateLimitConfig(env);
  const limiter = (spec: { windowMs: number; limit: number }, skip?: (req: Request) => boolean) =>
    createLimiter({ ...spec, disabled: limits.disabled, skip });
  // Stripe webhook must receive the raw body for signature verification.
  // Must be mounted BEFORE express.json() which would parse and discard it.
  // Each source has its own counter so one noisy provider cannot starve another.
  app.use("/webhooks/stripe", limiter(limits.webhook), express.raw({ type: "application/json" }), stripeWebhookRouter);
  app.use("/webhooks/gocardless", limiter(limits.webhook), express.raw({ type: "application/json" }), gocardlessWebhookRouter);
  app.use("/webhooks/ghl", limiter(limits.webhook), express.raw({ type: "application/json" }), ghlWebhookRouter);
  // SNS posts JSON with Content-Type text/plain; the signature covers the parsed fields, so read the raw body.
  app.use("/webhooks/ses", limiter(limits.webhook), express.raw({ type: () => true }), sesWebhookRouter);

  app.use(limiter(limits.global, (req) => req.path.startsWith("/health")));
  app.post("/auth/signup", limiter(limits.signup), (_req, _res, next) => next());
  const emailAdminLimiter = limiter(limits.emailAdmin);
  const inviteLimiter = limiter(limits.invite);
  app.get("/invites/:token", inviteLimiter, (_req, _res, next) => next());
  app.post("/invites/:token/accept", inviteLimiter, (_req, _res, next) => next());

  app.use(express.json({ limit: env.JSON_BODY_LIMIT || "100kb" }));

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
  // BE-18: readiness also pings the database and reports failed tenant migrations (count only).
  app.get("/health/ready", async (_req: Request, res: Response) => {
    if (!readiness.ready) return res.status(503).json({ status: "migrating" });
    try {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("db ping timeout")), DB_PING_TIMEOUT_MS);
      });
      try {
        await Promise.race([pingDb(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.error("[health] database ping failed:", err);
      return res.status(503).json({ status: "database_unavailable" });
    }
    const failed = readiness.failedTenantMigrations ?? 0;
    res.json({ status: failed > 0 ? "degraded" : "ready", failedTenantMigrations: failed });
  });

  app.use("/auth", authRouter);
  app.use("/invites", invitesRouter);
  app.use("/setup", setupRouter);
  // Before /settings: settingsRouter would otherwise see /settings/kpi-thresholds first.
  app.use("/settings/kpi-thresholds", kpiThresholdsRouter);
  app.use("/settings/email", emailAdminLimiter, settingsEmailRouter);
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
  app.use("/chat", chatRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/integrations", integrationsRouter);
  // Flo AI (admin only). Literal paths are registered before /conversations/:id inside the router.
  app.use("/flo", floRouter);
  app.use("/mobile", mobileRouter);

  // API docs — interactive UI at /docs, raw spec at /openapi.json. Public
  // outside production; in production only when EXPOSE_API_DOCS=true (BE-25).
  if (shouldExposeApiDocs(env)) {
    app.get("/openapi.json", (_req: Request, res: Response) => {
      res.json(openApiDocument);
    });
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  // BE-26: anything not matched above is an unknown route → 404. Documented
  // paths hit with an unsupported method never get here: the per-path
  // pre-filter above already answered 405 + Allow.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not Found" });
  });

  app.use(errorHandler);
  return app;
}

type ScheduleFn = (expression: string, task: () => void) => unknown;

// Cron runs in flight, so graceful shutdown can wait for them (BE-09).
const inFlightJobs = new Set<Promise<unknown>>();
export const waitForInFlightJobs = (): Promise<unknown> => Promise.allSettled([...inFlightJobs]);

function guarded(label: string, job: () => Promise<unknown>): () => void {
  return () => {
    const run = job().catch((err) => console.error(`[${label}] run failed:`, err));
    inFlightJobs.add(run);
    void run.finally(() => inFlightJobs.delete(run));
  };
}

/** Registers every cron job; returns the labels registered (for logs/tests). */
export function registerCronJobs(
  schedule: ScheduleFn = cron.schedule,
  env: NodeJS.ProcessEnv = process.env,
  tasks: Array<{ stop?: () => unknown }> = []
): string[] {
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
    // Every 2 min — re-run webhook events whose effect failed or was abandoned (BE-03)
    ["webhookRetry", "*/2 * * * *", runWebhookRetry],
    // Nightly at 04:00 UTC — mark unpaid payments past their invoice due date OVERDUE (BE-08; no reminders)
    ["overdueSweep", "0 4 * * *", () => runOverdueSweep()],
    // Nightly at 05:00 UTC: re-check tenants' sending-domain verification in SES (tier 2 -> tier 1 fallback)
    ["emailDomainRecheck", "0 5 * * *", () => runEmailDomainRecheck()],
    // Nightly at 03:30 UTC: purge Flo AI conversations past FLO_RETENTION_DAYS (default 90)
    ["floPurge", "30 3 * * *", () => runFloPurge()],
  ];
  // Every 15 min — pre-clean reminders (B2), opt-in per deployment
  if (isPreCleanRemindersEnabled(env)) {
    jobs.push(["preCleanReminders", "*/15 * * * *", () => runPreCleanReminders()]);
  }
  for (const [label, expression, job] of jobs) {
    const task = schedule(expression, guarded(label, job)) as { stop?: () => unknown } | undefined;
    if (task) tasks.push(task);
  }
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
  /** Process to hook SIGTERM/SIGINT on (src/index.ts passes `process`); omitted = no signal handling. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shutdownProc?: { on: (event: string, listener: (...args: any[]) => void) => unknown };
  disconnect?: () => Promise<unknown>;
}

/** Listen first (health → 503 "migrating"), then migrate tenant schemas, then
 *  mark ready and start cron. A migration failure exits the process with 1. */
export async function startServer(deps: StartServerDeps): Promise<{ app: Express; readiness: Readiness }> {
  const env = deps.env ?? process.env;
  const missing = listMissingIntegrationEnv(env);
  if (missing.length > 0) {
    console.warn(`[startup] missing integration env vars (those integrations will not work): ${missing.join(", ")}`);
  }

  const recommended = listMissingRecommendedEnv(env);
  if (recommended.length > 0) {
    console.warn(`[startup] recommended env vars not set (feature degrades): ${recommended.join(", ")}`);
  }

  const readiness: Readiness = { ready: false };
  const app = createApp({ allowedOrigins: deps.allowedOrigins, readiness });
  const listen = deps.listen ?? ((a: Express, port: number, cb: () => void) => a.listen(port, cb));
  const server = listen(app, deps.port, () => {
    console.log(`RoundFlow backend listening on http://localhost:${deps.port}`);
  }) as Parameters<typeof installGracefulShutdown>[0]["server"];

  const tasks: Array<{ stop?: () => unknown }> = [];
  if (deps.shutdownProc) {
    installGracefulShutdown({
      server,
      stopJobs: () => tasks.forEach((t) => t.stop?.()),
      waitForJobs: waitForInFlightJobs,
      disconnect:
        deps.disconnect ??
        (async () => {
          await disconnectAllTenantClients();
          await prisma.$disconnect();
        }),
      exit: deps.exit ?? ((code) => process.exit(code)),
      proc: deps.shutdownProc,
    });
  }

  try {
    const result = (await (deps.migrate ?? migrateAllTenantSchemas)()) as { failed?: string[] } | undefined;
    readiness.failedTenantMigrations = result?.failed?.length ?? 0;
  } catch (err) {
    console.error("FATAL: tenant migration failed —", err);
    (deps.exit ?? process.exit)(1);
    return { app, readiness };
  }
  readiness.ready = true;
  registerCronJobs(deps.schedule ?? cron.schedule, env, tasks);
  return { app, readiness };
}
