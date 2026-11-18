import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "p1", role: req.headers["x-role"] ?? "ADMIN", tenantId: "t1" };
    req.tenantPrisma = (globalThis as any).__tp;
    next();
  },
}));

const svc = {
  status: vi.fn(),
  link: vi.fn(),
  sendLink: vi.fn(),
  importCandidates: vi.fn(),
  importMandates: vi.fn(),
};
const createDirectDebitService = vi.fn((..._a: unknown[]) => svc);
vi.mock("../../services/direct-debit.service", () => ({
  createDirectDebitService: (...a: unknown[]) => createDirectDebitService(...a),
}));

import { customersRouter } from "../customers";
import { integrationsRouter } from "../integrations";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/customers", customersRouter);
app.use("/integrations", integrationsRouter);
app.use(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).__tp = { tag: "tp" };
});

describe("customer Direct Debit routes", () => {
  it("GET /customers/:id/direct-debit returns the status", async () => {
    svc.status.mockResolvedValue({ mandateStatus: null });
    const res = await request(app).get("/customers/c1/direct-debit");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mandateStatus: null });
    expect(svc.status).toHaveBeenCalledWith("c1");
    expect(createDirectDebitService).toHaveBeenCalledWith({ tag: "tp" }, { id: "p1", role: "ADMIN" });
  });

  it("POST /customers/:id/direct-debit/link returns the link", async () => {
    svc.link.mockResolvedValue({ url: "https://gc/x", expiresAt: null });
    const res = await request(app).post("/customers/c1/direct-debit/link");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://gc/x");
    expect(svc.link).toHaveBeenCalledWith("c1");
  });

  it("POST /customers/:id/direct-debit/send passes the channel, treating AUTO and none as best-available", async () => {
    svc.sendLink.mockResolvedValue({ status: "sent", channel: "EMAIL" });
    await request(app).post("/customers/c1/direct-debit/send").send({ channel: "sms" }).expect(200);
    expect(svc.sendLink).toHaveBeenLastCalledWith("c1", { channel: "sms" });
    await request(app).post("/customers/c1/direct-debit/send").send({ channel: "AUTO" }).expect(200);
    expect(svc.sendLink).toHaveBeenLastCalledWith("c1", { channel: undefined });
    await request(app).post("/customers/c1/direct-debit/send").expect(200);
    expect(svc.sendLink).toHaveBeenLastCalledWith("c1", { channel: undefined });
  });

  it("passes no tenant client through as a 500", async () => {
    (globalThis as any).__tp = undefined;
    const res = await request(app).get("/customers/c1/direct-debit");
    expect(res.status).toBe(500);
  });
});

describe("GoCardless mandate import routes", () => {
  it("GET lists candidates", async () => {
    svc.importCandidates.mockResolvedValue({ rows: [] });
    const res = await request(app).get("/integrations/gocardless/mandates/import");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [] });
  });

  it("POST links the confirmed pairs", async () => {
    svc.importMandates.mockResolvedValue({ linked: 1, failed: 0, results: [] });
    const res = await request(app)
      .post("/integrations/gocardless/mandates/import")
      .send({ links: [{ mandateId: "MD1", customerId: "c1" }] });
    expect(res.status).toBe(200);
    expect(svc.importMandates).toHaveBeenCalledWith([{ mandateId: "MD1", customerId: "c1" }]);
    expect(createDirectDebitService).toHaveBeenLastCalledWith({ tag: "tp" }, { id: "p1", role: "ADMIN" });
  });

  it("POST validates the links array", async () => {
    for (const body of [{}, { links: [] }, { links: "x" }, { links: Array(501).fill({ mandateId: "m", customerId: "c" }) }]) {
      const res = await request(app).post("/integrations/gocardless/mandates/import").send(body);
      expect(res.status).toBe(400);
    }
    const res = await request(app).post("/integrations/gocardless/mandates/import").send({ links: [{ mandateId: "MD1" }] });
    expect(res.status).toBe(400);
    expect(svc.importMandates).not.toHaveBeenCalled();
  });

  it("is ADMIN only", async () => {
    const res = await request(app).get("/integrations/gocardless/mandates/import").set("x-role", "MANAGER");
    expect(res.status).toBe(403);
    const post = await request(app).post("/integrations/gocardless/mandates/import").set("x-role", "MANAGER").send({ links: [{ mandateId: "m", customerId: "c" }] });
    expect(post.status).toBe(403);
  });
});
