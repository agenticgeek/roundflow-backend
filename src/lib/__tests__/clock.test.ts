import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { now, runWithClock, testClockEnabled, testClockMiddleware } from "../clock";
import { errorHandler } from "../error-handler";

const saved = { flag: process.env.ALLOW_TEST_CLOCK, env: process.env.NODE_ENV };
function setEnv(flag: string | undefined, nodeEnv: string | undefined) {
  if (flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
  else process.env.ALLOW_TEST_CLOCK = flag;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
}
afterEach(() => setEnv(saved.flag, saved.env));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeApp() {
  const app = express();
  app.use(testClockMiddleware);
  app.get("/now", async (req, res) => {
    await delay(Number(req.query.delay ?? 0));
    const first = now().toISOString();
    await delay(20);
    res.json({ first, second: now().toISOString() });
  });
  app.use(errorHandler);
  return app;
}

describe("testClockEnabled", () => {
  it.each([
    [undefined, "test", false],
    ["0", "test", false],
    ["true", "test", false],
    ["1", "test", true],
    ["1", undefined, true],
    ["1", "development", true],
    ["1", "production", false],
    [undefined, "production", false],
  ])("flag=%s NODE_ENV=%s -> %s", (flag, nodeEnv, expected) => {
    setEnv(flag, nodeEnv);
    expect(testClockEnabled()).toBe(expected);
  });

  it("reads the env at call time", () => {
    setEnv(undefined, "test");
    expect(testClockEnabled()).toBe(false);
    process.env.ALLOW_TEST_CLOCK = "1";
    expect(testClockEnabled()).toBe(true);
  });
});

describe("now / runWithClock", () => {
  const at = new Date("2030-03-04T05:06:07.000Z");

  it("is the real clock outside runWithClock", () => {
    setEnv("1", "test");
    const before = Date.now();
    const n = now().getTime();
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(Date.now());
  });

  it("returns the scoped instant when enabled, across awaits, and restores after", async () => {
    setEnv("1", "test");
    const seen = await runWithClock(at, async () => {
      await delay(5);
      return now();
    });
    expect(seen.toISOString()).toBe(at.toISOString());
    expect(now().getFullYear()).not.toBe(2030);
  });

  it("returns a copy, so mutating the result cannot corrupt the scoped clock", () => {
    setEnv("1", "test");
    runWithClock(at, () => {
      now().setUTCHours(0, 0, 0, 0);
      expect(now().toISOString()).toBe(at.toISOString());
    });
  });

  it("ignores a scoped instant when the flag is unset", () => {
    setEnv(undefined, "test");
    runWithClock(at, () => expect(now().getFullYear()).not.toBe(2030));
  });

  it("ignores a scoped instant in production even with the flag set", () => {
    setEnv("1", "production");
    runWithClock(at, () => expect(now().getFullYear()).not.toBe(2030));
  });
});

describe("testClockMiddleware", () => {
  beforeEach(() => setEnv("1", "test"));

  it("sets now() for the request from X-Test-Now", async () => {
    const res = await request(makeApp()).get("/now").set("X-Test-Now", "2031-01-02T03:04:05.000Z");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ first: "2031-01-02T03:04:05.000Z", second: "2031-01-02T03:04:05.000Z" });
  });

  it("uses the real clock when the header is absent", async () => {
    const res = await request(makeApp()).get("/now");
    expect(res.status).toBe(200);
    expect(new Date(res.body.first).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("answers 400 INVALID_TEST_NOW for an invalid value", async () => {
    const res = await request(makeApp()).get("/now").set("X-Test-Now", "not-a-date");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_TEST_NOW");
  });

  it("does not leak between concurrent requests", async () => {
    const app = makeApp();
    const [a, b, c] = await Promise.all([
      request(app).get("/now?delay=60").set("X-Test-Now", "2031-01-01T00:00:00.000Z"),
      request(app).get("/now?delay=10").set("X-Test-Now", "2032-02-02T00:00:00.000Z"),
      request(app).get("/now?delay=30"),
    ]);
    expect(a.body).toEqual({ first: "2031-01-01T00:00:00.000Z", second: "2031-01-01T00:00:00.000Z" });
    expect(b.body).toEqual({ first: "2032-02-02T00:00:00.000Z", second: "2032-02-02T00:00:00.000Z" });
    expect(new Date(c.body.first).getFullYear()).not.toBe(2031);
    expect(new Date(c.body.first).getFullYear()).not.toBe(2032);
  });

  it.each([
    ["flag unset", undefined, "test"],
    ["production with the flag set", "1", "production"],
  ])("is inert (%s): a valid header changes nothing and an invalid one is ignored", async (_l, flag, nodeEnv) => {
    setEnv(flag, nodeEnv);
    const app = makeApp();
    const ok = await request(app).get("/now").set("X-Test-Now", "2031-01-02T03:04:05.000Z");
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.first).getFullYear()).not.toBe(2031);
    const bad = await request(app).get("/now").set("X-Test-Now", "garbage");
    expect(bad.status).toBe(200);
  });
});
