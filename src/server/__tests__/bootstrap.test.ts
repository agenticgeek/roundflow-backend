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
  },
}));

vi.mock("node-cron", () => ({ default: { schedule } }));
vi.mock("../../lib/tenant-provisioning", () => ({ migrateAllTenantSchemas: migrate }));
vi.mock("../../jobs/visitGeneration", () => ({ runVisitGeneration: jobs.runVisitGeneration }));
vi.mock("../../jobs/outboxWorker", () => ({ runOutboxWorker: jobs.runOutboxWorker }));
vi.mock("../../jobs/geocodeBackfill", () => ({ runGeocodeBackfill: jobs.runGeocodeBackfill }));
vi.mock("../../jobs/kpiThresholds", () => ({ runKpiThresholdCheck: jobs.runKpiThresholdCheck }));
vi.mock("../../jobs/idempotencyPurge", () => ({ runIdempotencyPurge: jobs.runIdempotencyPurge }));
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
  const app = createApp({ allowedOrigins: ["http://localhost"], readiness });

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
    expect(res.body).toEqual({ status: "ready" });
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

  it("405s unmatched routes via the trailing handler", async () => {
    const res = await request(app).get("/definitely-not-a-route");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe(ALLOWED_METHODS);
  });

  it("returns a JSON 400 for malformed JSON bodies via the error handler", async () => {
    const res = await request(app).post("/definitely-not-a-route").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON in request body." });
  });

  it("mounts /settings/kpi-thresholds before /settings, and /technician-incidents", () => {
    const stack = (app as unknown as { _router: { stack: Array<{ handle: unknown }> } })._router.stack;
    const idx = (router: unknown) => stack.findIndex((l) => l.handle === router);
    expect(idx(kpiThresholdsRouter)).toBeGreaterThan(-1);
    expect(idx(kpiThresholdsRouter)).toBeLessThan(idx(settingsRouter));
    expect(idx(technicianIncidentsRouter)).toBeGreaterThan(-1);
  });
});

describe("registerCronJobs", () => {
  it("registers the base jobs and skips pre-clean reminders when disabled", () => {
    const labels = registerCronJobs(schedule, {});
    expect(labels).toEqual(["visitGen", "outbox", "geocodeBackfill", "kpiThresholds", "idempotencyPurge"]);
    expect(schedule).toHaveBeenCalledTimes(5);
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
    expect(console.error).toHaveBeenCalledTimes(6);
  });

  it("defaults to node-cron and process.env", () => {
    const prev = process.env.PRECLEAN_REMINDERS_ENABLED;
    delete process.env.PRECLEAN_REMINDERS_ENABLED;
    try {
      expect(registerCronJobs()).toHaveLength(5);
      expect(schedule).toHaveBeenCalledTimes(5);
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
    expect(sched).toHaveBeenCalledTimes(5);
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
