import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../bootstrap";

const saved = { flag: process.env.ALLOW_TEST_CLOCK, env: process.env.NODE_ENV };
afterEach(() => {
  if (saved.flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
  else process.env.ALLOW_TEST_CLOCK = saved.flag;
  process.env.NODE_ENV = saved.env;
});

const build = () => createApp({ allowedOrigins: [], readiness: { ready: true }, env: { RATE_LIMIT_DISABLED: "true" } as NodeJS.ProcessEnv });

describe.each([
  ["flag unset", undefined, "test"],
  ["flag 0", "0", "test"],
  ["NODE_ENV=production with the flag set", "1", "production"],
])("test hooks are absent (%s)", (_l, flag, nodeEnv) => {
  it("/test-hooks/run-nightly is 404 (not 401/403) and X-Test-Now is ignored without error", async () => {
    if (flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
    else process.env.ALLOW_TEST_CLOCK = flag;
    process.env.NODE_ENV = nodeEnv;
    const app = build();
    expect((await request(app).post("/test-hooks/run-nightly").send({})).status).toBe(404);
    expect((await request(app).get("/health").set("X-Test-Now", "garbage")).status).toBe(200);
  });
});

describe("test hooks are present when enabled", () => {
  it("mounts /test-hooks behind authentication and validates X-Test-Now", async () => {
    process.env.ALLOW_TEST_CLOCK = "1";
    process.env.NODE_ENV = "test";
    const app = build();
    expect((await request(app).post("/test-hooks/run-nightly").send({})).status).toBe(401);
    const bad = await request(app).get("/health").set("X-Test-Now", "garbage");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_TEST_NOW");
    expect((await request(app).get("/health").set("X-Test-Now", "2031-01-01T00:00:00.000Z")).status).toBe(200);
  });
});
