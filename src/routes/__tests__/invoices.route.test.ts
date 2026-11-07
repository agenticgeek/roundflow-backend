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

const batchPreview = vi.fn();
const batchSend = vi.fn();
const getBatch = vi.fn();
vi.mock("../../services/invoice-send-batch.service", () => ({
  MAX_BATCH: 500,
  createInvoiceSendBatchService: vi.fn(() => ({ preview: batchPreview, send: batchSend, getBatch })),
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
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "Internal error", code: err.code });
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

  it("BUG-006/007: a garbage or impossible dueDate is a 400 (never a 500), nothing is created", async () => {
    for (const dueDate of ["garbage", "2026-02-30", "2027-02-29"]) {
      const res = await request(makeApp()).post("/invoices").send({ visitId: "visit-1", dueDate });
      expect(res.status).toBe(400);
    }
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("passes through notes/dueDate when provided", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1" });

    const res = await request(makeApp())
      .post("/invoices")
      .send({ visitId: "visit-1", notes: "please pay promptly", dueDate: "2026-11-01", sendEmail: false });

    expect(res.status).toBe(201);
    expect(createInvoice).toHaveBeenCalledWith({
      visitId: "visit-1", notes: "please pay promptly", dueDate: "2026-11-01", sendEmail: false,
    });
  });

  it("BUG-008: sendEmail must be a boolean", async () => {
    for (const sendEmail of ["yes", 1, "true", {}]) {
      expect((await request(makeApp()).post("/invoices").send({ visitId: "visit-1", sendEmail })).status).toBe(400);
    }
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("sendEmail:true creates the invoice, then emails it (EMAIL channel) and reports emailSent", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-1" });
    sendInvoice.mockResolvedValue({ id: "inv-1", status: "SENT", messageId: "m1", pdfAttached: true });
    const res = await request(makeApp()).post("/invoices").send({ visitId: "visit-1", sendEmail: true });
    expect(res.status).toBe(201);
    expect(createInvoice).toHaveBeenCalledWith({ visitId: "visit-1", notes: null, dueDate: null, sendEmail: false });
    expect(sendInvoice).toHaveBeenCalledWith("inv-1", { channel: "EMAIL" });
    expect(res.body).toMatchObject({ id: "inv-1", emailSent: true, pdfAttached: true });
  });

  it("sendEmail:true keeps the created invoice when the email cannot be sent and says why", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-1" });
    sendInvoice.mockRejectedValue(Object.assign(new Error("Customer has no email address on file"), { statusCode: 400, code: "NO_CONTACT_FOR_CHANNEL" }));
    const res = await request(makeApp()).post("/invoices").send({ visitId: "visit-1", sendEmail: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "inv-1", emailSent: false, emailError: { code: "NO_CONTACT_FOR_CHANNEL", message: "Customer has no email address on file" } });
  });

  it("sendEmail:true reports a plain error without a code", async () => {
    createInvoice.mockResolvedValue({ id: "inv-1" });
    sendInvoice.mockRejectedValue(new Error("boom"));
    const res = await request(makeApp()).post("/invoices").send({ visitId: "visit-1", sendEmail: true });
    expect(res.body.emailError).toEqual({ code: "EMAIL_SEND_FAILED", message: "boom" });
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

describe("bulk send (ACT-01)", () => {
  it("accepts OVERDUE as a list status filter", async () => {
    listInvoices.mockResolvedValue({ rows: [] });
    expect((await request(makeApp()).get("/invoices?status=OVERDUE")).status).toBe(200);
    expect(listInvoices).toHaveBeenCalledWith(expect.objectContaining({ status: "OVERDUE" }), 1, 50);
  });

  it("POST /invoices/bulk-send/preview defaults to no ids/status and parses the view filters", async () => {
    batchPreview.mockResolvedValue({ total: 0 });
    const res = await request(makeApp()).post("/invoices/bulk-send/preview").send({});
    expect(res.status).toBe(200);
    expect(batchPreview).toHaveBeenCalledWith({
      ids: undefined, status: undefined, filters: { customerId: undefined, q: undefined, from: undefined, to: undefined },
      channel: undefined, resend: false,
    });
    await request(makeApp()).post("/invoices/bulk-send/preview").send({
      status: "OVERDUE", channel: "email", resend: true, filters: { customerId: "c1", q: " jo ", from: "2026-10-01", to: "2026-10-31" },
    });
    expect(batchPreview).toHaveBeenLastCalledWith({
      ids: undefined, status: "OVERDUE", channel: "EMAIL", resend: true,
      filters: { customerId: "c1", q: "jo", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") },
    });
  });

  it("POST /invoices/bulk-send answers 202 with the batch", async () => {
    batchSend.mockResolvedValue({ batchId: "b1", queued: 2, skipped: [] });
    const res = await request(makeApp()).post("/invoices/bulk-send").send({ ids: ["i1", "i2"] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ batchId: "b1", queued: 2, skipped: [] });
    expect(batchSend).toHaveBeenCalledWith(expect.objectContaining({ ids: ["i1", "i2"] }));
  });

  it("validates ids size, status, filters and channel", async () => {
    const app = makeApp();
    expect((await request(app).post("/invoices/bulk-send").send({ ids: [] })).status).toBe(400);
    expect((await request(app).post("/invoices/bulk-send").send({ ids: Array(501).fill("x") })).status).toBe(400);
    expect((await request(app).post("/invoices/bulk-send").send({ status: "LOST" })).status).toBe(400);
    expect((await request(app).post("/invoices/bulk-send").send({ filters: { from: "bad" } })).status).toBe(400);
    expect((await request(app).post("/invoices/bulk-send").send({ channel: "PIGEON" })).status).toBe(400);
    expect(batchSend).not.toHaveBeenCalled();
  });

  it("GET /invoices/bulk-send/:batchId is not captured by /:id", async () => {
    getBatch.mockResolvedValue({ batchId: "b1", results: [] });
    const res = await request(makeApp()).get("/invoices/bulk-send/b1");
    expect(res.status).toBe(200);
    expect(getBatch).toHaveBeenCalledWith("b1");
    expect(getInvoice).not.toHaveBeenCalled();
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

  it("exports the derived OVERDUE status too", async () => {
    exportInvoices.mockResolvedValue([]);
    const res = await request(makeApp()).get("/invoices/export.csv?status=OVERDUE");
    expect(res.status).toBe(200);
    expect(exportInvoices).toHaveBeenCalledWith(expect.objectContaining({ status: "OVERDUE" }));
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
  it("BUG-009: the invoice is looked up (404) before the body is judged: the method is validated by the service", async () => {
    markPaid.mockRejectedValueOnce(new AppError(404, "Invoice not found"));
    expect((await request(makeApp()).post("/invoices/nope/mark-paid").send({ method: "STRIPE" })).status).toBe(404);
    markPaid.mockRejectedValueOnce(new AppError(400, "method must be one of: BACS, CHEQUE, CASH"));
    expect((await request(makeApp()).post("/invoices/inv-1/mark-paid").send({})).status).toBe(400);
    expect(markPaid).toHaveBeenCalledWith("inv-1", expect.objectContaining({ method: undefined }), expect.anything());
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
