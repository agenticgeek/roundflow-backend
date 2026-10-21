import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (_req: any, _res: any, next: any) => {
    _req.profile = { tenantId: "tenant-1", role: "ADMIN" };
    next();
  },
}));
vi.mock("../../middleware/requireRole", () => ({
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  requireBusinessAccess: () => (_req: any, _res: any, next: any) => next(),
}));

const previewInvoice = vi.fn();
const getInvoice = vi.fn();
const getRenderData = vi.fn();
const createInvoice = vi.fn();
const sendInvoice = vi.fn();
vi.mock("../../services/invoice.service", () => ({
  createInvoiceService: vi.fn(() => ({ previewInvoice, getInvoice, getRenderData, createInvoice, sendInvoice })),
}));

const renderHtmlToPdf = vi.fn((..._args: unknown[]) => Promise.resolve(Buffer.from("")));
const invoiceHtml = vi.fn((..._args: unknown[]) => `<html>${JSON.stringify(_args[0])}</html>`);
vi.mock("../../integrations/pdf/render", () => ({
  renderHtmlToPdf: (...args: unknown[]) => renderHtmlToPdf(...args),
  invoiceHtml: (...args: unknown[]) => invoiceHtml(...args),
}));

import { invoicesRouter } from "../invoices";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    next();
  });
  app.use("/invoices", invoicesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /invoices/preview", () => {
  it("400s when visitId is missing", async () => {
    const res = await request(makeApp()).get("/invoices/preview");
    expect(res.status).toBe(400);
  });

  it("returns the preview for a visitId", async () => {
    previewInvoice.mockResolvedValue({ invoiceNumber: "INV-1" });
    const res = await request(makeApp()).get("/invoices/preview?visitId=visit-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoiceNumber: "INV-1" });
    expect(previewInvoice).toHaveBeenCalledWith("visit-1");
  });
});

describe("GET /invoices/preview/pdf", () => {
  it("400s when visitId is missing", async () => {
    const res = await request(makeApp()).get("/invoices/preview/pdf");
    expect(res.status).toBe(400);
  });

  it("renders a preview PDF with status PREVIEW", async () => {
    previewInvoice.mockResolvedValue({ invoiceNumber: "INV-1" });
    renderHtmlToPdf.mockResolvedValue(Buffer.from("pdf-bytes"));

    const res = await request(makeApp()).get("/invoices/preview/pdf?visitId=visit-1");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("INV-1-preview.pdf");
    expect(invoiceHtml).toHaveBeenCalledWith(expect.objectContaining({ invoiceNumber: "INV-1", status: "PREVIEW" }));
  });
});

describe("GET /invoices/:id", () => {
  it("returns the invoice", async () => {
    getInvoice.mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-1" });
    const res = await request(makeApp()).get("/invoices/inv-1");
    expect(res.status).toBe(200);
    expect(getInvoice).toHaveBeenCalledWith("inv-1");
  });

  it("propagates a 404 from the service", async () => {
    getInvoice.mockRejectedValue(new AppError(404, "Invoice not found"));
    const res = await request(makeApp()).get("/invoices/missing");
    expect(res.status).toBe(404);
  });
});

describe("GET /invoices/:id/pdf", () => {
  it("renders the saved invoice as a PDF", async () => {
    getRenderData.mockResolvedValue({ invoiceNumber: "INV-1", status: "SENT" });
    renderHtmlToPdf.mockResolvedValue(Buffer.from("pdf-bytes"));

    const res = await request(makeApp()).get("/invoices/inv-1/pdf");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("INV-1.pdf");
  });
});

describe("POST /invoices", () => {
  it("400s when visitId is missing", async () => {
    const res = await request(makeApp()).post("/invoices").send({});
    expect(res.status).toBe(400);
  });

  it("400s when req.body is undefined (?? {} fallback)", async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req.tenantPrisma = {};
      req.body = undefined;
      next();
    });
    app.use("/invoices", invoicesRouter);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error" });
    });

    const res = await request(app).post("/invoices");
    expect(res.status).toBe(400);
  });

  it("400s when visitId is not a string", async () => {
    const res = await request(makeApp()).post("/invoices").send({ visitId: 123 });
    expect(res.status).toBe(400);
  });

  it("creates an invoice with notes/dueDate/sendEmail defaults applied", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-1" });

    const res = await request(makeApp()).post("/invoices").send({ visitId: "visit-1" });

    expect(res.status).toBe(201);
    expect(createInvoice).toHaveBeenCalledWith({ visitId: "visit-1", notes: null, dueDate: null, sendEmail: false });
  });

  it("passes through notes/dueDate/sendEmail when provided", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1" });

    const res = await request(makeApp())
      .post("/invoices")
      .send({ visitId: "visit-1", notes: "please pay promptly", dueDate: "2026-11-01", sendEmail: true });

    expect(res.status).toBe(201);
    expect(createInvoice).toHaveBeenCalledWith({
      visitId: "visit-1", notes: "please pay promptly", dueDate: "2026-11-01", sendEmail: true,
    });
  });
});

describe("POST /invoices/:id/send", () => {
  it("sends the invoice", async () => {
    sendInvoice.mockResolvedValue({ id: "inv-1", status: "SENT" });
    const res = await request(makeApp()).post("/invoices/inv-1/send");
    expect(res.status).toBe(200);
    expect(sendInvoice).toHaveBeenCalledWith("inv-1");
  });

  it("propagates a 409 when already sent", async () => {
    sendInvoice.mockRejectedValue(new AppError(409, "Invoice has already been sent"));
    const res = await request(makeApp()).post("/invoices/inv-1/send");
    expect(res.status).toBe(409);
  });
});
