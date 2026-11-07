import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { enforceAdminOnlyRoutes, requireAdmin } from "../requireAdmin";
import { errorHandler } from "../../lib/error-handler";

function app(role: string | undefined) {
  const a = express();
  a.use((req, _res, next) => {
    if (role) req.profile = { role } as never;
    next();
  });
  a.use("/settings", enforceAdminOnlyRoutes());
  a.patch("/settings/payment", (_req, res) => res.json({ ok: true }));
  a.get("/settings/payment", (_req, res) => res.json({ ok: true }));
  a.delete("/settings/technicians/:id", (_req, res) => res.status(204).end());
  a.get("/only-admin", requireAdmin(), (_req, res) => res.json({ ok: true }));
  a.use(errorHandler);
  return a;
}

describe("requireAdmin / enforceAdminOnlyRoutes (BE-01)", () => {
  it("ADMIN passes", async () => {
    expect((await request(app("ADMIN")).patch("/settings/payment")).status).toBe(200);
    expect((await request(app("ADMIN")).delete("/settings/technicians/t1")).status).toBe(204);
    expect((await request(app("ADMIN")).get("/only-admin")).status).toBe(200);
  });

  it("MANAGER gets 403 ADMIN_ONLY on a listed route, but reads and unlisted routes are untouched", async () => {
    const res = await request(app("MANAGER")).patch("/settings/payment?x=1");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ADMIN_ONLY" });
    expect((await request(app("MANAGER")).delete("/settings/technicians/t1")).status).toBe(403);
    expect((await request(app("MANAGER")).get("/settings/payment")).status).toBe(200);
    expect((await request(app("MANAGER")).get("/only-admin")).status).toBe(403);
  });

  it("no profile means 403 ADMIN_ONLY too", async () => {
    expect((await request(app(undefined)).patch("/settings/payment")).body.code).toBe("ADMIN_ONLY");
  });
});
