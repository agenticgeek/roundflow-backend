import { it, expect, vi, beforeEach, describe } from "vitest";
import request from "supertest";
import express from "express";

const emptyPage = { rows: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };
const listComplaints = vi.fn();
const resolve = vi.fn();

vi.mock("../../services/complaint.service", () => ({
  createComplaintService: vi.fn(() => ({
    listComplaints,
    getComplaint: vi.fn(),
    logComplaint: vi.fn(),
    markInReview: vi.fn(),
    scheduleRevisit: vi.fn(),
    reopen: vi.fn(),
    resolve,
    assignTechnician: vi.fn(),
    getMessages: vi.fn(),
    addMessage: vi.fn(),
  })),
}));

vi.mock("../../services/reports.service", () => ({
  createReportsService: vi.fn(() => ({ logActivity: vi.fn() })),
}));

const queueGhlEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  queueGhlEvent: (...args: unknown[]) => queueGhlEvent(...args),
  syncMessageToGhl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.profile = { id: "profile-1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

import { complaintsRouter } from "../../routes/complaints";
import { AppError } from "../../lib/app-error";

function makeApp(tenantPrisma: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.tenantPrisma = tenantPrisma; next(); });
  app.use("/complaints", complaintsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listComplaints.mockResolvedValue(emptyPage);
});

it("complaintsRouter is exported", () => {
  expect(complaintsRouter).toBeDefined();
});

it("GET /complaints returns 200 with the paginated result as-is", async () => {
  const res = await request(makeApp()).get("/complaints");
  expect(res.status).toBe(200);
  expect(res.body).toEqual(emptyPage);
});

it("GET /complaints threads page/pageSize into the filters", async () => {
  await request(makeApp()).get("/complaints?page=2&pageSize=10");
  expect(listComplaints).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 10 }));
});

it("GET /complaints defaults page/pageSize when omitted", async () => {
  await request(makeApp()).get("/complaints");
  expect(listComplaints).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
});

it("GET /complaints passes status and search filters", async () => {
  await request(makeApp()).get("/complaints?status=OPEN&search=leak");
  expect(listComplaints).toHaveBeenCalledWith(expect.objectContaining({ status: "OPEN", search: "leak" }));
});

it("GET /complaints 400s for an invalid status", async () => {
  const res = await request(makeApp()).get("/complaints?status=NOT_A_STATUS");
  expect(res.status).toBe(400);
});

it("GET /complaints 400s when assignedTo is set to something other than 'me'", async () => {
  const res = await request(makeApp()).get("/complaints?assignedTo=someone-else");
  expect(res.status).toBe(400);
});

it("GET /complaints?assignedTo=me resolves the caller's own technicianId when one exists", async () => {
  const tenantPrisma = { technician: { findFirst: vi.fn().mockResolvedValue({ id: "tech-1" }) } };
  await request(makeApp(tenantPrisma)).get("/complaints?assignedTo=me");
  expect(tenantPrisma.technician.findFirst).toHaveBeenCalledWith({
    where: { profileId: "profile-1" },
    select: { id: true },
  });
  expect(listComplaints).toHaveBeenCalledWith(expect.objectContaining({ technicianId: "tech-1" }));
});

it("GET /complaints?assignedTo=me omits technicianId when the caller has no technician record", async () => {
  const tenantPrisma = { technician: { findFirst: vi.fn().mockResolvedValue(null) } };
  await request(makeApp(tenantPrisma)).get("/complaints?assignedTo=me");
  expect(listComplaints).toHaveBeenCalledWith(expect.not.objectContaining({ technicianId: expect.anything() }));
});

it("GET /complaints passes an explicit technicianId query param through", async () => {
  await request(makeApp()).get("/complaints?technicianId=tech-2");
  expect(listComplaints).toHaveBeenCalledWith(expect.objectContaining({ technicianId: "tech-2" }));
});

describe("POST /complaints/:id/resolve", () => {
  it("passes notes and the caller's profile id as resolvedBy", async () => {
    resolve.mockResolvedValue({ id: "cmp1", status: "RESOLVED", customerId: "cust-1" });
    const tp = {};
    const res = await request(makeApp(tp)).post("/complaints/cmp1/resolve").send({ notes: "Fixed on revisit" });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("cmp1", { notes: "Fixed on revisit", resolvedBy: "profile-1" });
    expect(queueGhlEvent).toHaveBeenCalledWith(tp, "complaint.resolved", "cust-1");
  });

  it("defaults notes to undefined when omitted", async () => {
    resolve.mockResolvedValue({ id: "cmp1", status: "RESOLVED", customerId: "cust-2" });
    const res = await request(makeApp()).post("/complaints/cmp1/resolve").send({});
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("cmp1", { notes: undefined, resolvedBy: "profile-1" });
  });

  it("passes upheld through", async () => {
    resolve.mockResolvedValue({ id: "cmp1", status: "RESOLVED", customerId: "cust-2" });
    const res = await request(makeApp()).post("/complaints/cmp1/resolve").send({ upheld: true });
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith("cmp1", { notes: undefined, resolvedBy: "profile-1", upheld: true });
  });

  it("400s when upheld is not a boolean", async () => {
    const res = await request(makeApp()).post("/complaints/cmp1/resolve").send({ upheld: "yes" });
    expect(res.status).toBe(400);
  });
});
