import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createLimiter, rateLimitConfig } from "../rate-limit";
import { requestId } from "../request-id";

describe("rateLimitConfig (BE-09)", () => {
  it("has sensible defaults", () => {
    const c = rateLimitConfig({});
    expect(c.disabled).toBe(false);
    expect(c.global).toEqual({ windowMs: 60_000, limit: 600 });
    expect(c.signup).toEqual({ windowMs: 3_600_000, limit: 10 });
    expect(c.invite).toEqual({ windowMs: 60_000, limit: 20 });
    expect(c.webhook).toEqual({ windowMs: 60_000, limit: 300 });
    expect(c.emailAdmin).toEqual({ windowMs: 3_600_000, limit: 60 });
  });

  it("reads overrides, ignores junk, and can be disabled", () => {
    const c = rateLimitConfig({
      RATE_LIMIT_DISABLED: "true",
      RATE_LIMIT_GLOBAL_PER_MIN: "5",
      RATE_LIMIT_SIGNUP_PER_HOUR: "0",
      RATE_LIMIT_INVITE_PER_MIN: "abc",
      RATE_LIMIT_WEBHOOK_PER_MIN: "7.9",
    });
    expect(c.disabled).toBe(true);
    expect(c.global.limit).toBe(5);
    expect(c.signup.limit).toBe(10);
    expect(c.invite.limit).toBe(20);
    expect(c.webhook.limit).toBe(7);
  });
});

describe("createLimiter", () => {
  const build = (opts: Parameters<typeof createLimiter>[0]) => {
    const app = express();
    app.use(requestId());
    app.use(createLimiter(opts));
    app.get("/", (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("returns 429 RATE_LIMITED with Retry-After and requestId once the limit is hit", async () => {
    const app = build({ windowMs: 60_000, limit: 2 });
    expect((await request(app).get("/")).status).toBe(200);
    expect((await request(app).get("/")).status).toBe(200);
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(res.body.error).toMatch(/too many requests/i);
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("429 without a request-id middleware omits requestId", async () => {
    const app = express();
    app.use(createLimiter({ windowMs: 60_000, limit: 1 }));
    app.get("/", (_req, res) => res.json({ ok: true }));
    await request(app).get("/");
    const res = await request(app).get("/");
    expect(res.status).toBe(429);
    expect(res.body).not.toHaveProperty("requestId");
  });

  it("is a pass-through when disabled and honours skip()", async () => {
    const off = build({ windowMs: 60_000, limit: 1, disabled: true });
    for (let i = 0; i < 3; i++) expect((await request(off).get("/")).status).toBe(200);
    const skipped = build({ windowMs: 60_000, limit: 1, skip: () => true });
    for (let i = 0; i < 3; i++) expect((await request(skipped).get("/")).status).toBe(200);
  });
});
