import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

const { schedule, migrate, jobs } = vi.hoisted(() => ({
  schedule: vi.fn(),
  migrate: vi.fn(),
  jobs: {
    runVisitGeneration: vi.fn(),
    runOutboxWorker: vi.fn(),
    runGeocodeBackfill: vi.fn(),
    runPreCleanReminders: vi.fn(),
    runKpiThresholdCheck: vi.fn(),
    runIdempotencyPurge: vi.fn(),
    runWebhookRetry: vi.fn(),
    runOverdueSweep: vi.fn(),
    runEmailDomainRecheck: vi.fn(),
    runFloPurge: vi.fn(),
  },
}));

vi.mock("node-cron", () => ({ default: { schedule } }));
vi.mock("../../lib/tenant-provisioning", () => ({ migrateAllTenantSchemas: migrate }));
vi.mock("../../jobs/visitGeneration", () => ({ runVisitGeneration: jobs.runVisitGeneration }));
vi.mock("../../jobs/outboxWorker", () => ({ runOutboxWorker: jobs.runOutboxWorker }));
vi.mock("../../jobs/geocodeBackfill", () => ({ runGeocodeBackfill: jobs.runGeocodeBackfill }));
vi.mock("../../jobs/kpiThresholds", () => ({ runKpiThresholdCheck: jobs.runKpiThresholdCheck }));
vi.mock("../../jobs/idempotencyPurge", () => ({ runIdempotencyPurge: jobs.runIdempotencyPurge }));
vi.mock("../../jobs/webhookRetry", () => ({ runWebhookRetry: jobs.runWebhookRetry }));
vi.mock("../../jobs/overdueSweep", () => ({ runOverdueSweep: jobs.runOverdueSweep }));
vi.mock("../../jobs/emailDomainRecheck", () => ({ runEmailDomainRecheck: jobs.runEmailDomainRecheck }));
vi.mock("../../jobs/floPurge", () => ({ runFloPurge: jobs.runFloPurge }));
vi.mock("../../jobs/preCleanReminders", async (orig) => ({
  ...((await orig()) as object),
  runPreCleanReminders: jobs.runPreCleanReminders,
}));

import {
  buildPathMethodMap,
  findBlockingEntry,
  createApp,
  registerCronJobs,
  startServer,
  shouldExposeApiDocs,
  installProcessErrorHandlers,
  ALLOWED_METHODS,
} from "../bootstrap";
import { openApiDocument } from "../../swagger";
import { kpiThresholdsRouter } from "../../routes/kpi-thresholds";
import { settingsRouter } from "../../routes/settings";
import { technicianIncidentsRouter } from "../../routes/technician-incidents";

const FULL_ENV = {
  STRIPE_SECRET_KEY: "x",
  STRIPE_CLIENT_ID: "x",
  STRIPE_CONNECT_WEBHOOK_SECRET: "x",
  GHL_CLIENT_ID: "x",
  GHL_CLIENT_SECRET: "x",
  ENCRYPTION_KEY: "x",
  PUBLIC_API_URL: "x",
  FRONTEND_URL: "x",
  GOOGLE_MAPS_GEOCODING_API_KEY: "x",
  SES_REGION: "eu-west-2",
  SES_FROM_DOMAIN_ADDRESS: "n@mail.roundflow.ai",
  ANTHROPIC_API_KEY: "x",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("buildPathMethodMap / findBlockingEntry", () => {
  const map = buildPathMethodMap({
    "/auth/v1/token": { post: {} },
    "/a": { get: {}, parameters: [] },
    "/a/{id}/b": { post: {}, put: {} },
  });

  it("skips /auth/v1, orders deepest first and maps {param} to a segment", () => {
    expect(map.map((e) => e.path)).toEqual(["/a/{id}/b", "/a"]);
    expect(map[0].allow).toBe("POST, PUT");
    expect(map[1].allow).toBe("GET");
    expect(map[0].pattern.test("/a/123/b")).toBe(true);
    expect(map[0].pattern.test("/a/1/2/b")).toBe(false);
  });

  it("returns the blocking entry only for a documented path without the method", () => {
    expect(findBlockingEntry(map, "DELETE", "/a/1/b")?.path).toBe("/a/{id}/b");
    expect(findBlockingEntry(map, "PUT", "/a/1/b")).toBeUndefined();
    expect(findBlockingEntry(map, "DELETE", "/unknown")).toBeUndefined();
  });
});

describe("createApp", () => {
  const readiness = { ready: false };
  const app = createApp({ allowedOrigins: ["http://localhost"], readiness, pingDb: async () => 1 });

  it("/health and /health/ready answer 503 migrating until ready, then 200", async () => {
    readiness.ready = false;
    let res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "migrating" });
    res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "migrating" });

    readiness.ready = true;
    res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
    res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", failedTenantMigrations: 0 });
  });

  it("405s non-standard methods with the global Allow list", async () => {
    const res = await request(app).propfind("/health");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
  });

  it("405s a standard method a documented path doesn't define, before auth", async () => {
    const entry = buildPathMethodMap(openApiDocument.paths as Record<string, Record<string, unknown>>).find(
      (e) => !e.allow.split(", ").includes("PATCH") && !e.path.includes("{")
    )!;
    const res = await request(app).patch(entry.path);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe(entry.allow);
  });

  it("serves the OpenAPI document", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.paths).toBeDefined();
  });

  it("BE-26: 404s unknown routes (not 405) via the trailing handler", async () => {
    const res = await request(app).get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not Found" });
    expect(res.headers.allow).toBeUndefined();
    expect((await request(app).post("/definitely-not-a-route")).status).toBe(404);
  });

  it("BE-26: a documented path with the wrong method still 405s with Allow", async () => {
    const res = await request(app).delete("/health");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET");
  });

  it("returns a JSON 400 for malformed JSON bodies via the error handler", async () => {
    const res = await request(app).post("/definitely-not-a-route").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Invalid JSON in request body." });
  });

  it("mounts /settings/kpi-thresholds before /settings, and /technician-incidents", () => {
    const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
    const idx = (router: unknown) => stack.findIndex((l) => l.handle === router);
    expect(idx(kpiThresholdsRouter)).toBeGreaterThan(-1);
    expect(idx(kpiThresholdsRouter)).toBeLessThan(idx(settingsRouter));
    expect(idx(technicianIncidentsRouter)).toBeGreaterThan(-1);
  });
});

describe("BE-25: API docs gating", () => {
  it("shouldExposeApiDocs: open outside production, flag-gated in production", () => {
    expect(shouldExposeApiDocs({})).toBe(true);
    expect(shouldExposeApiDocs({ NODE_ENV: "development" })).toBe(true);
    expect(shouldExposeApiDocs({ NODE_ENV: "production" })).toBe(false);
    expect(shouldExposeApiDocs({ NODE_ENV: "production", EXPOSE_API_DOCS: "false" })).toBe(false);
    expect(shouldExposeApiDocs({ NODE_ENV: "production", EXPOSE_API_DOCS: "true" })).toBe(true);
  });

  it("production without the flag serves 404 for /docs and /openapi.json", async () => {
    const prodApp = createApp({ allowedOrigins: [], readiness: { ready: true }, env: { NODE_ENV: "production" } });
    expect((await request(prodApp).get("/openapi.json")).status).toBe(404);
    expect((await request(prodApp).get("/docs/")).status).toBe(404);
  });

  it("production with EXPOSE_API_DOCS=true serves them", async () => {
    const prodApp = createApp({
      allowedOrigins: [],
      readiness: { ready: true },
      env: { NODE_ENV: "production", EXPOSE_API_DOCS: "true" },
    });
    expect((await request(prodApp).get("/openapi.json")).status).toBe(200);
  });
});

describe("BE-02: installProcessErrorHandlers", () => {
  it("logs unhandled rejections without exiting, and logs + exits(1) on uncaughtException", () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const proc = { on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => { handlers[ev] = fn; }) };
    const exit = vi.fn();
    installProcessErrorHandlers(proc, exit);

    handlers.unhandledRejection(new Error("lost"), Promise.resolve());
    expect(console.error).toHaveBeenCalledWith("[process] unhandledRejection:", expect.any(Error));
    expect(exit).not.toHaveBeenCalled();

    handlers.uncaughtException(new Error("fatal"));
    expect(console.error).toHaveBeenCalledWith("[process] uncaughtException:", expect.any(Error));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("defaults to the real process and process.exit", () => {
    const onSpy = vi.spyOn(process, "on").mockImplementation((() => process) as never);
    installProcessErrorHandlers();
    expect(onSpy).toHaveBeenCalledWith("unhandledRejection", expect.any(Function));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const call = onSpy.mock.calls.find((c) => c[0] === "uncaughtException")!;
    (call[1] as (e: Error) => void)(new Error("x"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("registerCronJobs", () => {
  it("registers the base jobs and skips pre-clean reminders when disabled", () => {
    const labels = registerCronJobs(schedule, {});
    expect(labels).toEqual(["visitGen", "outbox", "geocodeBackfill", "kpiThresholds", "idempotencyPurge", "webhookRetry", "overdueSweep", "emailDomainRecheck", "floPurge"]);
    expect(schedule).toHaveBeenCalledTimes(9);
  });

  it("adds pre-clean reminders when PRECLEAN_REMINDERS_ENABLED=true and runs/guards every task", async () => {
    const labels = registerCronJobs(schedule, { PRECLEAN_REMINDERS_ENABLED: "true" });
    expect(labels).toContain("preCleanReminders");
    expect(schedule).toHaveBeenCalledWith("*/15 * * * *", expect.any(Function));

    for (const fn of Object.values(jobs)) fn.mockResolvedValue(undefined);
    for (const [, task] of schedule.mock.calls) task();
    await new Promise((r) => setImmediate(r));
    for (const fn of Object.values(jobs)) expect(fn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();

    for (const fn of Object.values(jobs)) fn.mockRejectedValue(new Error("boom"));
    for (const [, task] of schedule.mock.calls) task();
    await new Promise((r) => setImmediate(r));
    expect(console.error).toHaveBeenCalledWith("[kpiThresholds] run failed:", expect.any(Error));
    expect(console.error).toHaveBeenCalledTimes(10);
  });

  it("defaults to node-cron and process.env", () => {
    const prev = process.env.PRECLEAN_REMINDERS_ENABLED;
    delete process.env.PRECLEAN_REMINDERS_ENABLED;
    try {
      expect(registerCronJobs()).toHaveLength(9);
      expect(schedule).toHaveBeenCalledTimes(9);
    } finally {
      if (prev !== undefined) process.env.PRECLEAN_REMINDERS_ENABLED = prev;
    }
  });
});

describe("startServer", () => {
  it("listens before migrating, then marks ready and starts cron", async () => {
    const order: string[] = [];
    let resolveMigrate!: () => void;
    const migrateFn = vi.fn(() => {
      order.push("migrate");
      return new Promise<void>((r) => (resolveMigrate = r));
    });
    const listen = vi.fn((_app, _port, cb: () => void) => {
      order.push("listen");
      cb();
    });
    const sched = vi.fn();
    const pending = startServer({ allowedOrigins: [], port: 1234, env: FULL_ENV, migrate: migrateFn, listen, schedule: sched });
    expect(order).toEqual(["listen", "migrate"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(":1234"));
    expect(console.warn).not.toHaveBeenCalled();
    expect(sched).not.toHaveBeenCalled();
    resolveMigrate();
    const { app, readiness } = await pending;
    expect(readiness.ready).toBe(true);
    expect(sched).toHaveBeenCalledTimes(9);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("serves 503 while migrating and exits(1) when migration fails", async () => {
    const exit = vi.fn();
    const { app, readiness } = await startServer({
      allowedOrigins: [],
      port: 1,
      env: {},
      migrate: () => Promise.reject(new Error("db down")),
      listen: () => undefined,
      exit,
      schedule,
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("STRIPE_SECRET_KEY"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("GOOGLE_MAPS_GEOCODING_API_KEY"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith("FATAL: tenant migration failed —", expect.any(Error));
    expect(readiness.ready).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    expect((await request(app).get("/health")).status).toBe(503);
  });

  it("defaults to app.listen, migrateAllTenantSchemas, node-cron and process.exit", async () => {
    const listenSpy = vi
      .spyOn(express.application, "listen")
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        (args[1] as () => void)();
        return {} as never;
      });
    migrate.mockResolvedValueOnce(undefined);
    await startServer({ allowedOrigins: [], port: 5 });
    expect(listenSpy).toHaveBeenCalledWith(5, expect.any(Function));
    expect(migrate).toHaveBeenCalled();
    expect(schedule).toHaveBeenCalled();

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    migrate.mockRejectedValueOnce(new Error("x"));
    await startServer({ allowedOrigins: [], port: 5 });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
