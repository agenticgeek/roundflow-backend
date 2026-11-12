import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const { schedule, migrate } = vi.hoisted(() => ({ schedule: vi.fn(), migrate: vi.fn() }));
vi.mock("node-cron", () => ({ default: { schedule } }));
vi.mock("../../lib/tenant-provisioning", () => ({ migrateAllTenantSchemas: migrate }));
const disconnectTenants = vi.hoisted(() => vi.fn());
vi.mock("../../lib/tenant-prisma-manager", async (orig) => ({
  ...((await orig()) as object),
  disconnectAllTenantClients: disconnectTenants,
}));
const prismaMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $disconnect: vi.fn() }));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

import { createApp, registerCronJobs, startServer, trustProxySetting, waitForInFlightJobs } from "../bootstrap";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const mk = (env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ allowedOrigins: [], readiness: { ready: true }, env: { RATE_LIMIT_DISABLED: "true", ...env }, ...extra });

describe("security headers + request id (BE-09)", () => {
  it("sets helmet headers and echoes X-Request-Id on every response, including 404 bodies", async () => {
    const res = await request(mk()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the docs UI usable: /docs has no CSP", async () => {
    const res = await request(mk()).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("maps an oversized JSON body to 413 PAYLOAD_TOO_LARGE with the request id", async () => {
    const res = await request(mk({ JSON_BODY_LIMIT: "20b" }))
      .post("/auth/signup")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ a: "x".repeat(200) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });
});

describe("rate limits (BE-09)", () => {
  const on = (env: NodeJS.ProcessEnv) => mk({ RATE_LIMIT_DISABLED: "false", ...env });

  it("429s POST /auth/signup after the signup limit with Retry-After and RATE_LIMITED", async () => {
    const app = on({ RATE_LIMIT_SIGNUP_PER_HOUR: "2" });
    await request(app).post("/auth/signup").send({});
    await request(app).post("/auth/signup").send({});
    const res = await request(app).post("/auth/signup").send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("429s the public invite token lookup and accept", async () => {
    const app = on({ RATE_LIMIT_INVITE_PER_MIN: "1" });
    await request(app).get("/invites/tok");
    expect((await request(app).get("/invites/tok")).status).toBe(429);
    const app2 = on({ RATE_LIMIT_INVITE_PER_MIN: "1" });
    await request(app2).post("/invites/tok/accept").send({});
    expect((await request(app2).post("/invites/tok/accept").send({})).status).toBe(429);
  });

  it("limits each webhook source separately", async () => {
    const app = on({ RATE_LIMIT_WEBHOOK_PER_MIN: "1" });
    for (const src of ["stripe", "gocardless", "ghl"]) {
      await request(app).post(`/webhooks/${src}`).send("{}");
      expect((await request(app).post(`/webhooks/${src}`).send("{}")).status).toBe(429);
    }
    const fresh = on({ RATE_LIMIT_WEBHOOK_PER_MIN: "1" });
    await request(fresh).post("/webhooks/stripe").send("{}");
    expect((await request(fresh).post("/webhooks/ghl").send("{}")).status).not.toBe(429);
  });

  it("applies a global default but never to /health", async () => {
    const app = on({ RATE_LIMIT_GLOBAL_PER_MIN: "2" });
    for (let i = 0; i < 4; i++) expect((await request(app).get("/health")).status).toBe(200);
    await request(app).get("/nope");
    await request(app).get("/nope");
    expect((await request(app).get("/nope")).status).toBe(429);
  });

  it("RATE_LIMIT_DISABLED=true switches every limiter off", async () => {
    const app = mk({ RATE_LIMIT_GLOBAL_PER_MIN: "1" });
    for (let i = 0; i < 3; i++) expect((await request(app).get("/nope")).status).toBe(404);
  });
});

describe("GET /health/ready (BE-18)", () => {
  it("503 migrating before readiness; no DB ping is made", async () => {
    const ping = vi.fn();
    const res = await request(createApp({ allowedOrigins: [], readiness: { ready: false }, env: {}, pingDb: ping })).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "migrating" });
    expect(ping).not.toHaveBeenCalled();
  });

  it("200 ready after a successful ping, 0 failed tenants", async () => {
    const res = await request(mk({}, { pingDb: async () => 1 })).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", failedTenantMigrations: 0 });
  });

  it("reports degraded with the number of failed tenant migrations", async () => {
    const app = createApp({ allowedOrigins: [], readiness: { ready: true, failedTenantMigrations: 2 }, env: {}, pingDb: async () => 1 });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "degraded", failedTenantMigrations: 2 });
  });

  it("503 database_unavailable when the ping fails", async () => {
    const res = await request(
      mk({}, {
        pingDb: async () => {
          throw new Error("down");
        },
      })
    ).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "database_unavailable" });
  });

  it("503 when the ping hangs past the timeout", async () => {
    const real = globalThis.setTimeout;
    // Only shorten the 3 s probe timeout; supertest's own timers stay real.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
      real(fn, ms === 3000 ? 5 : ms, ...a)) as never);
    const res = await request(mk({}, { pingDb: () => new Promise(() => {}) })).get("/health/ready");
    expect(res.status).toBe(503);
  });

  it("uses SELECT 1 on the public client by default", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ x: 1 }]);
    const res = await request(createApp({ allowedOrigins: [], readiness: { ready: true }, env: { RATE_LIMIT_DISABLED: "true" } })).get("/health/ready");
    expect(res.status).toBe(200);
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
  });
});

describe("trustProxySetting", () => {
  it("TRUST_PROXY wins; production defaults to one hop; otherwise off", () => {
    expect(trustProxySetting({ TRUST_PROXY: "2" })).toBe(2);
    expect(trustProxySetting({ TRUST_PROXY: "0" })).toBe(0);
    expect(trustProxySetting({ TRUST_PROXY: "yes" })).toBe(false);
    expect(trustProxySetting({ TRUST_PROXY: "-1" })).toBe(false);
    expect(trustProxySetting({ NODE_ENV: "production" })).toBe(1);
    expect(trustProxySetting({})).toBe(false);
  });
});

describe("startServer: failed migrations + graceful shutdown wiring", () => {
  const base = { allowedOrigins: [], port: 1, env: {}, schedule: vi.fn(() => ({})) };

  it("stores the failed tenant count for /health/ready", async () => {
    const { readiness } = await startServer({ ...base, migrate: async () => ({ failed: ["t_a", "t_b"] }), listen: () => ({ close: vi.fn() }) });
    expect(readiness).toMatchObject({ ready: true, failedTenantMigrations: 2 });
    const { readiness: r2 } = await startServer({ ...base, migrate: async () => undefined, listen: () => ({ close: vi.fn() }) });
    expect(r2.failedTenantMigrations).toBe(0);
    const { readiness: r3 } = await startServer({ ...base, migrate: async () => ({}), listen: () => ({ close: vi.fn() }) });
    expect(r3.failedTenantMigrations).toBe(0);
  });

  it("installs signal handlers that stop the crons, drain, disconnect and exit", async () => {
    const stop = vi.fn();
    const handlers: Record<string, () => void> = {};
    const exit = vi.fn();
    await startServer({
      ...base,
      migrate: async () => undefined,
      listen: () => ({ close: (cb: (e?: Error) => void) => cb() }),
      schedule: vi.fn(() => ({ stop })),
      exit,
      disconnect: async () => {},
      shutdownProc: {
        on: (ev: string, fn: () => void) => {
          handlers[ev] = fn;
        },
      },
    });
    handlers.SIGTERM();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stop).toHaveBeenCalled();
  });

  it("default disconnect closes tenant pools and the public client; default exit is process.exit", async () => {
    const handlers: Record<string, () => void> = {};
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await startServer({
      ...base,
      migrate: async () => undefined,
      listen: () => ({ close: (cb: (e?: Error) => void) => cb() }),
      shutdownProc: {
        on: (ev: string, fn: () => void) => {
          handlers[ev] = fn;
        },
      },
    });
    handlers.SIGINT();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(disconnectTenants).toHaveBeenCalled();
    expect(prismaMock.$disconnect).toHaveBeenCalled();
  });
});

describe("cron bookkeeping", () => {
  it("collects the scheduled tasks and tracks in-flight runs for the drain", async () => {
    const tasks: Array<{ stop?: () => unknown }> = [];
    const runs: Array<() => void> = [];
    const sched = vi.fn((_expr: string, fn: () => void) => {
      runs.push(fn);
      return { stop: vi.fn() };
    });
    registerCronJobs(sched as never, {}, tasks);
    expect(tasks.length).toBe(sched.mock.calls.length);
    expect(tasks[0].stop).toBeTypeOf("function");
    expect(await waitForInFlightJobs()).toEqual([]);
  });
});
