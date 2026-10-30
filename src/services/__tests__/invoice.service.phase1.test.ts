import { describe, it, expect, vi, beforeEach } from "vitest";

// Phase 1 audit remediation: A5 send, A7 mark-paid, B1 VAT rate, B5 bulk,
// GAP-028 list/export, GAP-032 completion/due-date/line-text rules.

vi.mock("../../lib/email", () => ({}));
const prepare = vi.fn();
const deliver = vi.fn();
vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ prepare, deliver })) }));
const queueGhlEvent = vi.fn();
vi.mock("../../integrations/ghl/sync", () => ({ queueGhlEvent: (...a: unknown[]) => queueGhlEvent(...a) }));
const releaseHoldIfSettled = vi.fn();
vi.mock("../payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));

import { createInvoiceService } from "../invoice.service";

const dec = (n: number) => ({ toNumber: () => n, valueOf: () => n });
type Fn = ReturnType<typeof vi.fn>;

function makePrisma(settings: Record<string, unknown> | null = null) {
  const prisma = {
    invoice: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    visit: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    payment: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    activityLog: { create: vi.fn() },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}
const svcOf = (p: ReturnType<typeof makePrisma>) => createInvoiceService(p as never);

function visit(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1",
    status: "COMPLETED",
    date: new Date("2026-10-30T00:00:00Z"),
    price: dec(20),
    paymentMethod: null,
    paymentHold: false,
    invoice: null,
    property: {
      addressLine: "1 High St",
      postcode: "NE66 1AA",
      customer: { id: "c1", name: "Jo Bloggs", email: null, phone: "07", paymentMethod: null, holdNextClean: false },
    },
    round: null,
    technician: null,
    service: null,
    servicePlan: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueGhlEvent.mockResolvedValue(undefined);
  releaseHoldIfSettled.mockResolvedValue(false);
});

describe("GAP-032 rules on create/preview", () => {
  it("409 VISIT_NOT_COMPLETED for preview and create", async () => {
    const p = makePrisma();
    p.visit.findUnique.mockResolvedValue(visit({ status: "SCHEDULED" }));
    await expect(svcOf(p).previewInvoice("v1")).rejects.toMatchObject({ statusCode: 409, code: "VISIT_NOT_COMPLETED" });
    await expect(svcOf(p).createInvoice({ visitId: "v1", sendEmail: false })).rejects.toMatchObject({ code: "VISIT_NOT_COMPLETED" });
  });

  it("409 ALREADY_INVOICED when the visit already has an invoice", async () => {
    const p = makePrisma();
    p.visit.findUnique.mockResolvedValue(visit({ invoice: { id: "i" } }));
    await expect(svcOf(p).createInvoice({ visitId: "v1", sendEmail: false })).rejects.toMatchObject({ code: "ALREADY_INVOICED" });
  });

  it("defaults dueDate to today + invoiceDueDays and uses BusinessSettings.vatRate (B1)", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T15:00:00Z"), toFake: ["Date"] });
    const p = makePrisma({ vatInInvoices: true, vatRate: dec(5), invoiceDueDays: 14 });
    p.visit.findUnique.mockResolvedValue(visit());
    p.invoice.create.mockResolvedValue({ id: "i1", invoiceNumber: "INV-2026-001", status: "DRAFT", sentToCustomer: false, sentAt: null, dueDate: null });
    const created = await svcOf(p).createInvoice({ visitId: "v1", sendEmail: false });
    const data = (p.invoice.create as Fn).mock.calls[0][0].data;
    expect(data.dueDate).toEqual(new Date("2026-11-13T00:00:00Z"));
    expect(data.amount.toNumber()).toBe(21);
    expect(created.total).toBe(21);
    vi.useRealTimers();
  });

  it("preview: default due date is 7 days without settings; line text falls back to the plan's service", async () => {
    const p = makePrisma();
    p.visit.findUnique.mockResolvedValue(visit({ servicePlan: { service: { name: "Gutter Clearing" } } }));
    const preview = await svcOf(p).previewInvoice("v1");
    expect(preview.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(preview.lineItems[0].description).toBe("Gutter Clearing — 2026-10-30");
  });

  it("line text uses 'Window cleaning' when the plan has no service", async () => {
    const p = makePrisma();
    p.visit.findUnique.mockResolvedValue(visit({ servicePlan: { service: null } }));
    expect((await svcOf(p).previewInvoice("v1")).lineItems[0].description).toBe("Window cleaning — 2026-10-30");
  });

  it("line text falls back to the round's default service when visit and plan have none", async () => {
    const p = makePrisma();
    p.visit.findUnique.mockResolvedValue(visit({ round: { name: "Mon", defaultService: { name: "Conservatory" } } }));
    expect((await svcOf(p).previewInvoice("v1")).lineItems[0].description).toBe("Conservatory — Mon — 2026-10-30");
  });

  it("VAT at 0% charges nothing extra", async () => {
    const p = makePrisma({ vatInInvoices: true, vatRate: dec(0) });
    p.visit.findUnique.mockResolvedValue(visit());
    const preview = await svcOf(p).previewInvoice("v1");
    expect(preview.vatAmount).toBe(0);
    expect(preview.total).toBe(20);
  });
});

describe("B5 invoice numbering", () => {
  it("takes an advisory lock and numbers past the highest existing suffix", async () => {
    const p = makePrisma();
    const year = new Date().getFullYear();
    p.visit.findUnique.mockResolvedValue(visit());
    p.invoice.findMany.mockResolvedValue([{ invoiceNumber: `INV-${year}-007` }, { invoiceNumber: `INV-${year}-x` }]);
    p.invoice.create.mockResolvedValue({ id: "i1", invoiceNumber: "n", status: "DRAFT", sentToCustomer: false, sentAt: null });
    await svcOf(p).createInvoice({ visitId: "v1", sendEmail: false });
    expect(p.$executeRaw).toHaveBeenCalledTimes(1);
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect((p.invoice.create as Fn).mock.calls[0][0].data.invoiceNumber).toBe(`INV-${year}-008`);
  });
});

describe("getInvoice VAT rate", () => {
  it("backs VAT out of the total at the configured rate", async () => {
    const p = makePrisma({ vatInInvoices: true, vatRate: dec(5) });
    p.invoice.findUnique.mockResolvedValue({
      id: "i1", invoiceNumber: "INV-1", status: "SENT", amount: dec(21), dueDate: null, paidAt: null, notes: null,
      sentToCustomer: true, sentAt: null, createdAt: new Date(), customerId: "c1", visitId: null,
      customer: { name: "Jo", email: null, phone: null, paymentMethod: null }, visit: null,
    });
    const inv = await svcOf(p).getInvoice("i1");
    expect(inv.vatAmount).toBe(1);
    expect(inv.subtotal).toBe(20);
  });
});

describe("listCustomerInvoices", () => {
  it("exposes the visit's payment {id,status,method} and paidAt", async () => {
    const p = makePrisma();
    const paidAt = new Date();
    p.invoice.findMany.mockResolvedValue([
      { id: "i1", invoiceNumber: "A", status: "PAID", amount: dec(5), dueDate: null, paidAt, sentToCustomer: true, sentAt: null, createdAt: new Date(), visitId: "v1",
        visit: { payment: { id: "pay1", status: "PAID", method: "BACS" } } },
      { id: "i2", invoiceNumber: "B", status: "SENT", amount: dec(5), dueDate: null, paidAt: null, sentToCustomer: true, sentAt: null, createdAt: new Date(), visitId: null, visit: null },
    ]);
    const rows = await svcOf(p).listCustomerInvoices("c1");
    expect(rows[0]).toMatchObject({ paidAt, payment: { id: "pay1", status: "PAID", method: "BACS" } });
    expect(rows[1].payment).toBeNull();
  });
});

describe("GAP-028 listInvoices / exportInvoices", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "i1", invoiceNumber: "INV-1", amount: dec(12.5), status: "SENT", createdAt: new Date("2026-10-01T00:00:00Z"),
    dueDate: null, paidAt: null, visitId: "v1",
    customer: { id: "c1", name: "Jo", paymentMethod: "CASH" },
    visit: { paymentMethod: "CHEQUE", payment: { method: "BACS" } },
    ...overrides,
  });

  it("builds the where clause from every filter and paginates", async () => {
    const p = makePrisma();
    p.invoice.count.mockResolvedValue(3);
    p.invoice.findMany.mockResolvedValue([row()]);
    const from = new Date("2026-10-01T00:00:00Z");
    const to = new Date("2026-10-31T00:00:00Z");
    const result = await svcOf(p).listInvoices({ status: "SENT", customerId: "c1", from, to, q: "jo" }, 2, 2);
    expect(p.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "SENT",
        customerId: "c1",
        createdAt: { gte: from, lt: new Date("2026-11-01T00:00:00Z") },
        OR: [
          { invoiceNumber: { contains: "jo", mode: "insensitive" } },
          { customer: { name: { contains: "jo", mode: "insensitive" } } },
        ],
      },
      take: 2,
      skip: 2,
    }));
    expect(result.pagination).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(result.rows[0]).toEqual({
      id: "i1", invoiceNumber: "INV-1", customer: { id: "c1", name: "Jo" }, total: 12.5, status: "SENT",
      issuedAt: new Date("2026-10-01T00:00:00Z"), dueDate: null, paidAt: null, paymentMethod: "BACS", visitId: "v1",
    });
  });

  it("supports a one-sided date range and no filters", async () => {
    const p = makePrisma();
    p.invoice.count.mockResolvedValue(0);
    const from = new Date("2026-10-01T00:00:00Z");
    await svcOf(p).listInvoices({ from }, 1, 50);
    expect((p.invoice.findMany as Fn).mock.calls[0][0].where).toEqual({ createdAt: { gte: from } });
    await svcOf(p).listInvoices({ to: from }, 1, 50);
    expect((p.invoice.findMany as Fn).mock.calls[1][0].where).toEqual({ createdAt: { lt: new Date("2026-10-02T00:00:00Z") } });
    await svcOf(p).listInvoices({}, 1, 50);
    expect((p.invoice.findMany as Fn).mock.calls[2][0].where).toEqual({});
  });

  it("falls the payment method back payment → visit → customer → null", async () => {
    const p = makePrisma();
    p.invoice.findMany.mockResolvedValue([
      row({ visit: { paymentMethod: "CHEQUE", payment: null } }),
      row({ visit: null }),
      row({ visit: null, customer: { id: "c1", name: "Jo", paymentMethod: null }, visitId: null }),
    ]);
    const rows = await svcOf(p).exportInvoices({});
    expect(rows.map((r) => r.paymentMethod)).toEqual(["CHEQUE", "CASH", null]);
    expect(rows[0]).toMatchObject({ invoiceNumber: "INV-1", customerId: "c1", customerName: "Jo", total: "12.50" });
  });

  it("listInvoices maps a null visitId to null", async () => {
    const p = makePrisma();
    p.invoice.count.mockResolvedValue(1);
    p.invoice.findMany.mockResolvedValue([row({ visitId: undefined, visit: null })]);
    expect((await svcOf(p).listInvoices({}, 1, 50)).rows[0].visitId).toBeNull();
  });
});

describe("A5 sendInvoice", () => {
  const invoice = (status: string) => ({
    id: "i1", invoiceNumber: "INV-1", status, customerId: "c1", amount: dec(30), dueDate: new Date("2026-11-06T00:00:00Z"),
    customer: { name: "Jo Bloggs" },
  });

  it("404s when the invoice doesn't exist", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(null);
    await expect(svcOf(p).sendInvoice("x")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("D-7: 409 INVOICE_NOT_SENDABLE for PAID and VOID", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValueOnce(invoice("PAID")).mockResolvedValueOnce(invoice("VOID"));
    await expect(svcOf(p).sendInvoice("i1")).rejects.toMatchObject({ statusCode: 409, code: "INVOICE_NOT_SENDABLE" });
    await expect(svcOf(p).sendInvoice("i1", { resend: true })).rejects.toMatchObject({ code: "INVOICE_NOT_SENDABLE" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("D-7: 409 INVOICE_ALREADY_SENT unless resend is true", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(invoice("SENT"));
    await expect(svcOf(p).sendInvoice("i1")).rejects.toMatchObject({ code: "INVOICE_ALREADY_SENT" });
    prepare.mockResolvedValue({ prep: 1 });
    deliver.mockResolvedValue({ messageId: "m1", channel: "SMS" });
    p.invoice.update.mockResolvedValue({ id: "i1", invoiceNumber: "INV-1", status: "SENT", sentToCustomer: true, sentAt: new Date() });
    await expect(svcOf(p).sendInvoice("i1", { resend: true })).resolves.toMatchObject({ messageId: "m1" });
  });

  it("renders the tenant template, delivers through GHL, then marks SENT", async () => {
    const p = makePrisma({ currency: "£", businessName: "Coates Windows" });
    p.invoice.findUnique.mockResolvedValue(invoice("DRAFT"));
    p.messageTemplate.findFirst.mockResolvedValue({ id: "tpl", body: "Hi [Customer Name], {{invoiceNumber}} {{amount}} due {{dueDate}} from {{businessName}}{{zzz}}" });
    prepare.mockResolvedValue({ prep: 1 });
    deliver.mockResolvedValue({ messageId: "m1", channel: "EMAIL" });
    const sentAt = new Date();
    p.invoice.update.mockResolvedValue({ id: "i1", invoiceNumber: "INV-1", status: "SENT", sentToCustomer: true, sentAt });

    const result = await svcOf(p).sendInvoice("i1", { channel: "EMAIL" });

    expect(prepare).toHaveBeenCalledWith("c1", "EMAIL");
    expect(deliver).toHaveBeenCalledWith({ prep: 1 }, "Hi Jo Bloggs, INV-1 £30.00 due 2026-11-06 from Coates Windows", { templateId: "tpl" });
    expect(p.invoice.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: { status: "SENT", sentToCustomer: true, sentAt: expect.any(Date) },
    });
    expect(result).toEqual({ id: "i1", invoiceNumber: "INV-1", status: "SENT", sentToCustomer: true, sentAt, messageId: "m1", channel: "EMAIL" });
  });

  it("leaves the invoice untouched when GHL fails", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(invoice("DRAFT"));
    prepare.mockResolvedValue({});
    deliver.mockRejectedValue(Object.assign(new Error("GHL down"), { statusCode: 502, code: "GHL_SEND_FAILED" }));
    await expect(svcOf(p).sendInvoice("i1")).rejects.toMatchObject({ code: "GHL_SEND_FAILED" });
    expect(p.invoice.update).not.toHaveBeenCalled();
  });
});

describe("A7 markPaid", () => {
  const invoice = (overrides: Record<string, unknown> = {}) => ({
    id: "i1", invoiceNumber: "INV-1", status: "SENT", customerId: "c1", visitId: "v1", amount: dec(33), ...overrides,
  });
  const paidInvoice = (paidAt: Date) => ({ id: "i1", invoiceNumber: "INV-1", status: "PAID", paidAt, amount: dec(33) });
  const payment = (method: string, paidAt: Date, reference: string | null = null) => ({ id: "pay1", status: "PAID", method, amount: dec(33), paidAt, reference });

  it("404 / 409 already PAID / 409 VOID", async () => {
    const p = makePrisma();
    p.invoice.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(invoice({ status: "PAID" }))
      .mockResolvedValueOnce(invoice({ status: "VOID" }));
    await expect(svcOf(p).markPaid("i1", { method: "BACS" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(svcOf(p).markPaid("i1", { method: "BACS" })).rejects.toMatchObject({ statusCode: 409, code: "INVOICE_ALREADY_PAID" });
    await expect(svcOf(p).markPaid("i1", { method: "BACS" })).rejects.toMatchObject({ statusCode: 409, code: "INVOICE_VOID" });
  });

  it("400 AMOUNT_MISMATCH when the amount differs from the total", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(invoice());
    await expect(svcOf(p).markPaid("i1", { method: "CASH", amount: 30 })).rejects.toMatchObject({ statusCode: 400, code: "AMOUNT_MISMATCH" });
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("updates the visit's existing Payment, marks the invoice PAID, logs, queues GHL and auto-releases", async () => {
    const p = makePrisma();
    const paidAt = new Date("2026-10-30T00:00:00Z");
    p.invoice.findUnique.mockResolvedValue(invoice());
    p.payment.findUnique.mockResolvedValue({ id: "pay1" });
    p.payment.update.mockResolvedValue(payment("CHEQUE", paidAt, "CHQ 123"));
    p.invoice.update.mockResolvedValue(paidInvoice(paidAt));

    const result = await svcOf(p).markPaid("i1", { method: "CHEQUE", reference: "CHQ 123", paidAt, amount: 33 }, { id: "prof-1", role: "ADMIN" });

    expect(p.payment.update).toHaveBeenCalledWith({
      where: { id: "pay1" },
      data: { amount: expect.anything(), method: "CHEQUE", status: "PAID", paidAt, reference: "CHQ 123" },
    });
    expect(p.invoice.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "PAID", paidAt } });
    expect(p.activityLog.create).toHaveBeenCalledWith({
      data: { type: "INVOICE_MARKED_PAID", message: "Invoice INV-1 marked paid (CHEQUE, ref CHQ 123)", actorId: "prof-1", actorRole: "ADMIN" },
    });
    expect(queueGhlEvent).toHaveBeenCalledWith(p, "payment.collected", "c1");
    expect(releaseHoldIfSettled).toHaveBeenCalledWith(p, "c1");
    expect(result).toEqual({
      invoice: { id: "i1", invoiceNumber: "INV-1", status: "PAID", paidAt, amount: 33 },
      payment: { id: "pay1", status: "PAID", method: "CHEQUE", amount: 33, paidAt, reference: "CHQ 123" },
    });
  });

  it("creates a Payment row when the visit has none, defaulting paidAt/actor/reference", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(invoice());
    p.payment.findUnique.mockResolvedValue(null);
    p.payment.create.mockResolvedValue(payment("BACS", new Date()));
    p.invoice.update.mockResolvedValue(paidInvoice(new Date()));
    const result = await svcOf(p).markPaid("i1", { method: "BACS" });
    expect(p.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ customerId: "c1", visitId: "v1", method: "BACS", status: "PAID", paidAt: expect.any(Date), reference: null }),
    });
    expect(p.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ message: "Invoice INV-1 marked paid (BACS)", actorId: null, actorRole: null }),
    });
    expect(result.payment.reference).toBeNull();
  });

  it("creates an unlinked Payment for a standalone invoice (no visit), and logs a failed GHL queue", async () => {
    const p = makePrisma();
    p.invoice.findUnique.mockResolvedValue(invoice({ visitId: null }));
    p.payment.create.mockResolvedValue(payment("CASH", new Date()));
    p.invoice.update.mockResolvedValue(paidInvoice(new Date()));
    queueGhlEvent.mockRejectedValue(new Error("outbox"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await svcOf(p).markPaid("i1", { method: "CASH" }, {});
    expect(p.payment.findUnique).not.toHaveBeenCalled();
    expect((p.payment.create as Fn).mock.calls[0][0].data.visitId).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("B5 bulk invoices", () => {
  const day = new Date("2026-10-30T00:00:00Z");

  function bulkVisits() {
    return [
      visit({ id: "ok1", paymentMethod: "BACS" }),
      visit({ id: "ok2", property: { addressLine: "2 Low St", postcode: null, customer: { id: "c2", name: "Al", email: null, phone: null, paymentMethod: null, holdNextClean: false } } }),
      visit({ id: "inv", invoice: { id: "x" } }),
      visit({ id: "sched", status: "SCHEDULED" }),
      visit({ id: "hold", paymentHold: true }),
      visit({ id: "custhold", property: { addressLine: "3", postcode: "P", customer: { id: "c3", name: "Hy", email: null, phone: null, paymentMethod: "CASH", holdNextClean: true } } }),
    ];
  }

  it("previewBulk lists invoiceable visits and skip reasons with totals", async () => {
    const p = makePrisma({ vatInInvoices: true });
    p.visit.findMany.mockResolvedValue(bulkVisits());
    const result = await svcOf(p).previewBulk(new Date("2026-10-30T12:00:00Z"), ["zzz"]);
    expect(p.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { date: { gte: day, lt: new Date("2026-10-31T00:00:00Z") }, status: { not: "CANCELLED" }, id: { notIn: ["zzz"] } },
    }));
    expect(result.items).toEqual([
      { visitId: "ok1", customerName: "Jo Bloggs", address: "1 High St, NE66 1AA", amount: 20, vat: 4, total: 24, paymentMethod: "BACS" },
      { visitId: "ok2", customerName: "Al", address: "2 Low St", amount: 20, vat: 4, total: 24, paymentMethod: null },
    ]);
    expect(result.skipped).toEqual([
      { visitId: "inv", customerName: "Jo Bloggs", reason: "ALREADY_INVOICED" },
      { visitId: "sched", customerName: "Jo Bloggs", reason: "NOT_COMPLETED" },
      { visitId: "hold", customerName: "Jo Bloggs", reason: "ON_HOLD" },
      { visitId: "custhold", customerName: "Hy", reason: "ON_HOLD" },
    ]);
    expect(result.totals).toEqual({ count: 2, amount: "48.00" });
  });

  it("previewBulk with no exclusions doesn't filter by id", async () => {
    const p = makePrisma();
    await svcOf(p).previewBulk(day);
    expect((p.visit.findMany as Fn).mock.calls[0][0].where.id).toBeUndefined();
  });

  it("createBulk creates per item and reports a failure without stopping", async () => {
    const p = makePrisma();
    p.visit.findMany.mockResolvedValue([visit({ id: "a" }), visit({ id: "b" })]);
    p.visit.findUnique
      .mockResolvedValueOnce(visit({ id: "a" }))
      .mockResolvedValueOnce(visit({ id: "b", invoice: { id: "raced" } }));
    p.invoice.create.mockResolvedValue({ id: "i-a", invoiceNumber: "INV-1", status: "DRAFT", sentToCustomer: false, sentAt: null });
    const result = await svcOf(p).createBulk(day);
    expect(result.created).toEqual([{ visitId: "a", invoiceId: "i-a", invoiceNumber: "INV-1", total: 20 }]);
    expect(result.failed).toEqual([{ visitId: "b", error: "Visit already has an invoice" }]);
    expect(result.totals).toEqual({ count: 1, amount: "20.00" });
  });

  it("createBulk sendNow sends each invoice and reports created-but-unsent ones", async () => {
    const p = makePrisma();
    p.visit.findMany.mockResolvedValue([visit({ id: "a" }), visit({ id: "b" })]);
    p.visit.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(visit({ id: where.id })));
    p.invoice.create
      .mockResolvedValueOnce({ id: "i-a", invoiceNumber: "INV-1", status: "DRAFT", sentToCustomer: false, sentAt: null })
      .mockResolvedValueOnce({ id: "i-b", invoiceNumber: "INV-2", status: "DRAFT", sentToCustomer: false, sentAt: null });
    p.invoice.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ id: where.id, invoiceNumber: "n", status: "DRAFT", customerId: "c1", amount: dec(20), dueDate: null, customer: { name: "Jo" } }));
    prepare.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Customer has no mobile number on file"));
    deliver.mockResolvedValue({ messageId: "m", channel: "SMS" });
    p.invoice.update.mockResolvedValue({ id: "i-a", invoiceNumber: "INV-1", status: "SENT", sentToCustomer: true, sentAt: new Date() });

    const result = await svcOf(p).createBulk(day, [], { sendNow: true, channel: "SMS" });

    expect(prepare).toHaveBeenCalledWith("c1", "SMS");
    expect(result.created).toEqual([
      { visitId: "a", invoiceId: "i-a", invoiceNumber: "INV-1", total: 20, sent: true },
      { visitId: "b", invoiceId: "i-b", invoiceNumber: "INV-2", total: 20, sent: false },
    ]);
    expect(result.failed).toEqual([
      { visitId: "b", invoiceId: "i-b", error: "Invoice created but not sent: Customer has no mobile number on file" },
    ]);
  });
});
