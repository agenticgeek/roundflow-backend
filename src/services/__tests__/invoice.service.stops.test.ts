import { beforeEach, describe, expect, it, vi } from "vitest";

// One invoice per billing group: the anchor visit + every visit completed with it (billedWithVisitId = anchor).
// docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.5

vi.mock("../../lib/email", () => ({}));
vi.mock("../message.service", () => ({ createMessageService: vi.fn() }));
const releaseHoldIfSettled = vi.fn();
vi.mock("../payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));

import { createInvoiceService } from "../invoice.service";

const dec = (n: number) => ({ toNumber: () => n });

const visit = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "COMPLETED",
  paymentHold: false,
  date: new Date("2026-11-19T00:00:00Z"),
  createdAt: new Date("2026-11-01T00:00:00Z"),
  price: dec(20),
  paymentMethod: null,
  billedWithVisitId: null,
  invoice: null,
  invoiceLine: null,
  payment: null,
  service: { name: `Service ${id}` },
  servicePlan: null,
  round: { name: "Monday", defaultService: null },
  technician: { name: "Sam" },
  property: { addressLine: "1 High St", postcode: "X1", customer: { id: "c1", name: "Jo", email: null, phone: null, paymentMethod: null, holdNextClean: false } },
  ...extra,
});

function makePrisma(target: ReturnType<typeof visit>, group: ReturnType<typeof visit>[], settings: Record<string, unknown> = { vatInInvoices: true, vatRate: 20, invoiceDueDays: 7 }) {
  const prisma: any = {
    invoice: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: "inv1", invoiceNumber: "INV-2026-001", sentToCustomer: false, sentAt: null, ...data }),
      ),
    },
    visit: { findUnique: vi.fn().mockResolvedValue(target), findMany: vi.fn().mockResolvedValue(group) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("createInvoice for a billing group", () => {
  it("invoices the anchor and its siblings, one stored line per service with VAT per line", async () => {
    const anchor = visit("v1", { price: dec(10.05) });
    const sib = visit("v2", { price: dec(10.05), billedWithVisitId: "v1", service: { name: "Gutter clear" } });
    const prisma = makePrisma(sib, [anchor, sib]);

    const out = await createInvoiceService(prisma).createInvoice({ visitId: "v2", sendEmail: false });

    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ id: "v1" }, { billedWithVisitId: "v1" }], status: "COMPLETED" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.visitId).toBe("v1");
    expect(Number(data.amount)).toBe(24.12); // (10.05 + 2.01) x 2
    expect(data.lines.create).toEqual([
      expect.objectContaining({ visitId: "v1", description: "Service v1 — Monday — 2026-11-19", netAmount: 10.05, vatAmount: 2.01, amount: 12.06, sortOrder: 0 }),
      expect.objectContaining({ visitId: "v2", description: "Gutter clear — Monday — 2026-11-19", netAmount: 10.05, vatAmount: 2.01, amount: 12.06, sortOrder: 1 }),
    ]);
    expect(out.total).toBe(24.12);
  });

  it("leaves out members that are already invoiced (as an anchor or on a line)", async () => {
    const anchor = visit("v1", { invoice: { id: "old" } });
    const lined = visit("v2", { billedWithVisitId: "v1", invoiceLine: { id: "line" } });
    const fresh = visit("v3", { billedWithVisitId: "v1" });
    const prisma = makePrisma(fresh, [anchor, lined, fresh], { vatInInvoices: false });
    await createInvoiceService(prisma).createInvoice({ visitId: "v3", sendEmail: false });
    const data = prisma.invoice.create.mock.calls[0][0].data;
    expect(data.visitId).toBe("v3");
    expect(data.lines.create.map((l: any) => l.visitId)).toEqual(["v3"]);
    expect(Number(data.amount)).toBe(20);
  });

  it("a visit completed on its own (no group) still gets one stored line", async () => {
    const solo = visit("v1");
    const prisma = makePrisma(solo, [solo]);
    await createInvoiceService(prisma).createInvoice({ visitId: "v1", sendEmail: false });
    expect(prisma.invoice.create.mock.calls[0][0].data.lines.create).toHaveLength(1);
  });

  it("is PAID when the group's payment (on the anchor) is PAID", async () => {
    const paidAt = new Date("2026-11-19T10:00:00Z");
    const anchor = visit("v1", { payment: { status: "PAID", paidAt, method: "CASH" } });
    const sib = visit("v2", { billedWithVisitId: "v1" });
    const prisma = makePrisma(sib, [anchor, sib]);
    await createInvoiceService(prisma).createInvoice({ visitId: "v2", sendEmail: false });
    expect(prisma.invoice.create.mock.calls[0][0].data).toMatchObject({ status: "PAID", paidAt });
    expect(releaseHoldIfSettled).toHaveBeenCalledWith(prisma, "c1");
  });

  it("refuses a visit that is already on an invoice line", async () => {
    const prisma = makePrisma(visit("v2", { invoiceLine: { id: "l1" } }), []);
    await expect(createInvoiceService(prisma).createInvoice({ visitId: "v2", sendEmail: false })).rejects.toMatchObject({
      statusCode: 409,
      code: "ALREADY_INVOICED",
    });
  });

  it("autoCreateForCompletedVisit treats an invoice line as already invoiced", async () => {
    const prisma = makePrisma(visit("v2", { invoiceLine: { id: "l1" } }), []);
    await expect(createInvoiceService(prisma).autoCreateForCompletedVisit("v2")).resolves.toBeNull();
  });
});

describe("previewInvoice for a billing group", () => {
  it("shows every member's line with its visit and date, and the group total", async () => {
    const anchor = visit("v1");
    const sib = visit("v2", { billedWithVisitId: "v1", price: dec(5) });
    const prisma = makePrisma(anchor, [anchor, sib]);
    const preview = await createInvoiceService(prisma).previewInvoice("v1");
    expect(preview.lineItems).toEqual([
      { description: "Service v1 — Monday — 2026-11-19", technicianName: "Sam", amount: 20, visitId: "v1", date: "2026-11-19" },
      { description: "Service v2 — Monday — 2026-11-19", technicianName: "Sam", amount: 5, visitId: "v2", date: "2026-11-19" },
    ]);
    expect(preview).toMatchObject({ subtotal: 25, vatAmount: 5, total: 30 });
  });
});

describe("saved invoices", () => {
  const settings = { vatInInvoices: true, vatRate: 20, currency: "£" };
  const savedInvoice = (lines: unknown[]) => ({
    id: "inv1",
    invoiceNumber: "INV-2026-001",
    status: "DRAFT",
    amount: dec(36),
    dueDate: null,
    paidAt: null,
    notes: null,
    sentToCustomer: false,
    sentAt: null,
    createdAt: new Date("2026-11-19T12:00:00Z"),
    customerId: "c1",
    visitId: "v1",
    customer: { id: "c1", name: "Jo", email: null, phone: null, paymentMethod: null },
    visit: visit("v1"),
    lines,
  });
  const storedLines = [
    { visitId: "v1", description: "Window clean — Monday — 2026-11-19", netAmount: dec(20), vatAmount: dec(4), amount: dec(24), sortOrder: 0, visit: { date: new Date("2026-11-19T00:00:00Z"), technician: { name: "Sam" } } },
    { visitId: "v2", description: "Gutter clear — Monday — 2026-11-18", netAmount: dec(10), vatAmount: dec(2), amount: dec(12), sortOrder: 1, visit: { date: new Date("2026-11-18T00:00:00Z"), technician: null } },
  ];
  const prismaFor = (inv: unknown) => ({
    invoice: { findUnique: vi.fn().mockResolvedValue(inv) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
  });

  it("getInvoice lists the stored lines", async () => {
    const prisma: any = prismaFor(savedInvoice(storedLines));
    const out = await createInvoiceService(prisma).getInvoice("inv1");
    expect(out.lineItems).toEqual([
      { description: "Window clean — Monday — 2026-11-19", technicianName: "Sam", amount: 20, visitId: "v1", date: "2026-11-19" },
      { description: "Gutter clear — Monday — 2026-11-18", technicianName: null, amount: 10, visitId: "v2", date: "2026-11-18" },
    ]);
    expect(out).toMatchObject({ subtotal: 30, vatAmount: 6, amount: 36 });
  });

  it("a stored line whose visit was deleted keeps its text and amount, with no date", async () => {
    const prisma: any = prismaFor(savedInvoice([{ ...storedLines[0], visitId: null, visit: null }]));
    const out = await createInvoiceService(prisma).getInvoice("inv1");
    expect(out.lineItems).toEqual([
      { description: "Window clean — Monday — 2026-11-19", technicianName: null, amount: 20, visitId: null, date: null },
    ]);
  });

  it("getInvoice of an invoice made before lines existed still shows its one line", async () => {
    const prisma: any = prismaFor({ ...savedInvoice([]), amount: dec(24) });
    const out = await createInvoiceService(prisma).getInvoice("inv1");
    expect(out.lineItems).toEqual([
      { description: "Service v1 — Monday — 2026-11-19", technicianName: "Sam", amount: 20, visitId: "v1", date: "2026-11-19" },
    ]);
  });

  it("getRenderData (PDF) uses the stored lines", async () => {
    const prisma: any = prismaFor(savedInvoice(storedLines));
    const out = await createInvoiceService(prisma).getRenderData("inv1");
    expect(out.lineItems.map((l) => [l.description, l.amount])).toEqual([
      ["Window clean — Monday — 2026-11-19", 20],
      ["Gutter clear — Monday — 2026-11-18", 10],
    ]);
    expect(out).toMatchObject({ subtotal: 30, vatAmount: 6, total: 36 });
  });
});

describe("bulk invoices group by billing group", () => {
  it("one item per group, with every member's id and the group total", async () => {
    const a1 = visit("v1");
    const a2 = visit("v2", { billedWithVisitId: "v1", price: dec(10) });
    const solo = visit("v3", { property: { addressLine: "2 Low Rd", postcode: "Y2", customer: { id: "c2", name: "Al", email: null, phone: null, paymentMethod: null, holdNextClean: false } } });
    const prisma: any = makePrisma(a1, []);
    prisma.visit.findMany.mockResolvedValue([a1, a2, solo]);
    const out = await createInvoiceService(prisma).previewBulk(new Date("2026-11-19T00:00:00Z"));
    expect(out.items).toEqual([
      expect.objectContaining({ visitId: "v1", visitIds: ["v1", "v2"], amount: 30, vat: 6, total: 36, customerName: "Jo" }),
      expect.objectContaining({ visitId: "v3", visitIds: ["v3"], amount: 20, vat: 4, total: 24, customerName: "Al" }),
    ]);
    expect(out.totals).toEqual({ count: 2, amount: "60.00" });
  });

  it("an already-invoiced or unfinished member is skipped on its own; the rest of the group stays", async () => {
    const a1 = visit("v1", { invoice: { id: "old" } });
    const a2 = visit("v2", { billedWithVisitId: "v1" });
    const open = visit("v4", { status: "SCHEDULED" });
    const prisma: any = makePrisma(a1, []);
    prisma.visit.findMany.mockResolvedValue([a1, a2, open]);
    const out = await createInvoiceService(prisma).previewBulk(new Date("2026-11-19T00:00:00Z"));
    expect(out.items).toEqual([expect.objectContaining({ visitId: "v2", visitIds: ["v2"] })]);
    expect(out.skipped.map((s: any) => [s.visitId, s.reason])).toEqual([
      ["v1", "ALREADY_INVOICED"],
      ["v4", "NOT_COMPLETED"],
    ]);
  });
});
