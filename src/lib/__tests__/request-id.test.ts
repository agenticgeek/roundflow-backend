import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { getRequestId, requestId } from "../request-id";

const app = express();
app.use(requestId());
app.get("/", (_req, res) => res.json({ id: getRequestId(res) }));

describe("requestId middleware (BE-09)", () => {
  it("generates a UUID, exposes it on res.locals and echoes the header", async () => {
    const res = await request(app).get("/");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.id).toBe(res.headers["x-request-id"]);
  });

  it("keeps a well-formed incoming id", async () => {
    const res = await request(app).get("/").set("X-Request-Id", "web-1234abcd");
    expect(res.headers["x-request-id"]).toBe("web-1234abcd");
  });

  it("replaces a malformed or oversized incoming id", async () => {
    for (const bad of ["short", "has space in it!!", "x".repeat(65)]) {
      const res = await request(app).get("/").set("X-Request-Id", bad);
      expect(res.headers["x-request-id"]).not.toBe(bad);
    }
  });

  it("getRequestId is undefined without the middleware", () => {
    expect(getRequestId({ locals: {} } as never)).toBeUndefined();
    expect(getRequestId({} as never)).toBeUndefined();
  });
});
