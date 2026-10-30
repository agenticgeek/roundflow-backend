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
const listInvoices = vi.fn();
const exportInvoices = vi.fn();
const previewBulk = vi.fn();
const createBulk = vi.fn();
const markPaid = vi.fn();
vi.mock("../../services/invoice.service", () => ({
  createInvoiceService: vi.fn(() => ({
    previewInvoice, getInvoice, getRenderData, createInvoice, sendInvoice,
    listInvoices, exportInvoices, previewBulk, createBulk, markPaid,
  })),
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
  it("sends the invoice with the auto channel and no resend by default", async () => {
    sendInvoice.mockResolvedValue({ id: "inv-1", status: "SENT" });
    const res = await request(makeApp()).post("/invoices/inv-1/send");
    expect(res.status).toBe(200);
    expect(sendInvoice).toHaveBeenCalledWith("inv-1", { channel: undefined, resend: false });
  });

  it("passes channel and resend through", async () => {
    sendInvoice.mockResolvedValue({ id: "inv-1", status: "SENT" });
    await request(makeApp()).post("/invoices/inv-1/send").send({ channel: "whatsapp", resend: true });
    expect(sendInvoice).toHaveBeenCalledWith("inv-1", { channel: "WHATSAPP", resend: true });
  });

  it("400s on a bad channel or resend", async () => {
    expect((await request(makeApp()).post("/invoices/inv-1/send").send({ channel: "fax" })).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/inv-1/send").send({ resend: "yes" })).status).toBe(400);
  });

  it("propagates a 409 when already sent", async () => {
    sendInvoice.mockRejectedValue(new AppError(409, "Invoice has already been sent", "INVOICE_ALREADY_SENT"));
    const res = await request(makeApp()).post("/invoices/inv-1/send");
    expect(res.status).toBe(409);
  });
});

describe("GET /invoices (list) and /invoices/export.csv", () => {
  it("lists with parsed filters and default pagination", async () => {
    listInvoices.mockResolvedValue({ rows: [], pagination: { page: 1 } });
    const res = await request(makeApp()).get("/invoices?status=SENT&from=2026-10-01&to=2026-10-31&customerId=c1&q=%20jo%20");
    expect(res.status).toBe(200);
    expect(listInvoices).toHaveBeenCalledWith(
      {
        status: "SENT",
        from: new Date("2026-10-01T00:00:00Z"),
        to: new Date("2026-10-31T00:00:00Z"),
        customerId: "c1",
        q: "jo",
      },
      1,
      50
    );
  });

  it("treats blank q / customerId as absent and honours page/pageSize", async () => {
    listInvoices.mockResolvedValue({ rows: [] });
    await request(makeApp()).get("/invoices?q=%20&customerId=&page=2&pageSize=10");
    expect(listInvoices).toHaveBeenCalledWith(
      { status: undefined, from: undefined, to: undefined, customerId: undefined, q: undefined },
      2,
      10
    );
  });

  it("400s on a bad status or date", async () => {
    expect((await request(makeApp()).get("/invoices?status=LOST")).status).toBe(400);
    expect((await request(makeApp()).get("/invoices?from=30-10-2026")).status).toBe(400);
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("exports CSV (not captured by /:id)", async () => {
    exportInvoices.mockResolvedValue([{ invoiceNumber: "INV-1", total: "1.00" }]);
    const res = await request(makeApp()).get("/invoices/export.csv?status=PAID");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("invoices.csv");
    expect(res.text).toBe("invoiceNumber,total\nINV-1,1.00");
    expect(getInvoice).not.toHaveBeenCalled();
  });
});

describe("POST /invoices/bulk/preview and /invoices/bulk", () => {
  it("previews for a date with exclusions", async () => {
    previewBulk.mockResolvedValue({ items: [], skipped: [], totals: { count: 0, amount: "0.00" } });
    const res = await request(makeApp()).post("/invoices/bulk/preview").send({ date: "2026-10-30", excludeVisitIds: ["v9"] });
    expect(res.status).toBe(200);
    expect(previewBulk).toHaveBeenCalledWith(new Date("2026-10-30T00:00:00Z"), ["v9"]);
  });

  it("400s without a date, with a bad date or bad exclusions", async () => {
    expect((await request(makeApp()).post("/invoices/bulk/preview").send({})).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/bulk/preview").send({ date: "2026-02-30" })).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/bulk").send({ date: "2026-10-30", excludeVisitIds: "v1" })).status).toBe(400);
  });

  it("creates with defaults (no exclusions, sendNow false, auto channel)", async () => {
    createBulk.mockResolvedValue({ created: [], failed: [], totals: { count: 0, amount: "0.00" } });
    const res = await request(makeApp()).post("/invoices/bulk").send({ date: "2026-10-30" });
    expect(res.status).toBe(200);
    expect(createBulk).toHaveBeenCalledWith(new Date("2026-10-30T00:00:00Z"), [], { sendNow: false, channel: undefined });
  });

  it("passes sendNow and channel", async () => {
    createBulk.mockResolvedValue({ created: [] });
    await request(makeApp()).post("/invoices/bulk").send({ date: "2026-10-30", sendNow: true, channel: "EMAIL" });
    expect(createBulk).toHaveBeenCalledWith(expect.any(Date), [], { sendNow: true, channel: "EMAIL" });
  });
});

describe("POST /invoices/:id/mark-paid", () => {
  it("validates the method", async () => {
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "STRIPE" })).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({})).status).toBe(400);
    expect(markPaid).not.toHaveBeenCalled();
  });

  it("validates reference, paidAt and amount", async () => {
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "BACS", reference: 5 })).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "BACS", paidAt: "nope" })).status).toBe(400);
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "BACS", amount: "33" })).status).toBe(400);
  });

  it("marks paid with all fields and the acting profile", async () => {
    markPaid.mockResolvedValue({ invoice: { status: "PAID" }, payment: { id: "p1" } });
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.tenantPrisma = {}; next(); });
    app.use("/invoices", invoicesRouter);
    const res = await request(app)
      .post("/invoices/inv-1/mark-paid")
      .send({ method: "CHEQUE", reference: "CHQ 1", paidAt: "2026-10-30", amount: 33 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invoice: { status: "PAID" }, payment: { id: "p1" } });
    expect(markPaid).toHaveBeenCalledWith(
      "inv-1",
      { method: "CHEQUE", reference: "CHQ 1", paidAt: new Date("2026-10-30"), amount: 33 },
      { id: undefined, role: "ADMIN" }
    );
  });

  it("defaults the optional fields", async () => {
    markPaid.mockResolvedValue({});
    await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "CASH" });
    expect(markPaid).toHaveBeenCalledWith("inv-1", { method: "CASH", reference: null, paidAt: null, amount: undefined }, expect.anything());
  });

  it("propagates 409 already paid", async () => {
    markPaid.mockRejectedValue(new AppError(409, "Invoice is already paid", "INVOICE_ALREADY_PAID"));
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({ method: "CASH" })).status).toBe(409);
  });
});

describe("POST /invoices/:id/send with no body", () => {
  it("tolerates an undefined body", async () => {
    sendInvoice.mockResolvedValue({ id: "inv-1" });
    const app = express();
    app.use((req: any, _res, next) => { req.tenantPrisma = {}; req.body = undefined; next(); });
    app.use("/invoices", invoicesRouter);
    const res = await request(app).post("/invoices/inv-1/send");
    expect(res.status).toBe(200);
    expect(sendInvoice).toHaveBeenCalledWith("inv-1", { channel: undefined, resend: false });
  });
});
