import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/email", () => ({ sendInvoiceEmail: vi.fn().mockResolvedValue(undefined) }));
import { createInvoiceService } from "../invoice.service";

function makePrisma() {
  return {
    invoice: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    visit: { findUnique: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
  } as unknown as Parameters<typeof createInvoiceService>[0];
}

it("createInvoiceService returns an object", () => {
  const svc = createInvoiceService(makePrisma());
  expect(svc).toBeDefined();
});

it("previewInvoice is a function", () => {
  const svc = createInvoiceService(makePrisma());
  expect(typeof svc.previewInvoice).toBe("function");
});

it("previewInvoice throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createInvoiceService(prisma);
  await expect(svc.previewInvoice("bad-id")).rejects.toMatchObject({ statusCode: 404 });
});

it("previewInvoice throws 409 when visit already has an invoice", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ invoice: { id: "inv-1" } });
  const svc = createInvoiceService(prisma);
  await expect(svc.previewInvoice("visit-1")).rejects.toMatchObject({ statusCode: 409 });
});

it("previewInvoice returns the customer name", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: "NE66 1SS",
      customer: { id: "cust-1", name: "John Smith", email: "j@example.com", phone: null, paymentMethod: null },
    },
    round: { name: "Alnwick Monday" },
    technician: { name: "James Smith" },
    service: { name: "Window Cleaning" },
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createInvoiceService(prisma);
  const result = await svc.previewInvoice("visit-1");
  expect(result.customer.name).toBe("John Smith");
});

it("previewInvoice returns the visit price as amount", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: "NE66 1SS",
      customer: { id: "cust-1", name: "John Smith", email: null, phone: null, paymentMethod: null },
    },
    round: null,
    technician: null,
    service: null,
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createInvoiceService(prisma);
  const result = await svc.previewInvoice("visit-1");
  expect(result.amount).toBe(35);
});

it("previewInvoice returns invoiceNumber in INV-YYYY-NNN format", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: null,
      customer: { id: "cust-1", name: "John Smith", email: null, phone: null, paymentMethod: null },
    },
    round: null,
    technician: null,
    service: null,
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createInvoiceService(prisma);
  const result = await svc.previewInvoice("visit-1");
  expect(result.invoiceNumber).toMatch(/^INV-\d{4}-\d+$/);
});

it("previewInvoice sets vatAmount to 0 when vatInInvoices is false", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: null,
      customer: { id: "cust-1", name: "John Smith", email: null, phone: null, paymentMethod: null },
    },
    round: null,
    technician: null,
    service: null,
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ vatInInvoices: false });
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createInvoiceService(prisma);
  const result = await svc.previewInvoice("visit-1");
  expect(result.vatAmount).toBe(0);
});

it("createInvoice is a function", () => {
  const svc = createInvoiceService(makePrisma());
  expect(typeof svc.createInvoice).toBe("function");
});

it("createInvoice throws 404 when visit does not exist", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createInvoiceService(prisma);
  await expect(svc.createInvoice({ visitId: "bad-id", sendEmail: false })).rejects.toMatchObject({ statusCode: 404 });
});

it("createInvoice throws 409 when visit already has an invoice", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ invoice: { id: "inv-1" } });
  const svc = createInvoiceService(prisma);
  await expect(svc.createInvoice({ visitId: "visit-1", sendEmail: false })).rejects.toMatchObject({ statusCode: 409 });
});

it("createInvoice returns an id", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: null,
      customer: { id: "cust-1", name: "John Smith", email: null, phone: null, paymentMethod: null },
    },
    round: null,
    technician: null,
    service: null,
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-new",
    invoiceNumber: "INV-2026-001",
    status: "DRAFT",
    sentToCustomer: false,
    sentAt: null,
  });
  const svc = createInvoiceService(prisma);
  const result = await svc.createInvoice({ visitId: "visit-1", sendEmail: false });
  expect(result.id).toBe("inv-new");
});

it("createInvoice sets status to DRAFT when sendEmail is false", async () => {
  const prisma = makePrisma();
  (prisma.visit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "visit-1",
    date: new Date("2026-08-12T00:00:00Z"),
    price: { toNumber: () => 35 },
    paymentMethod: null,
    invoice: null,
    property: {
      addressLine: "12 Market Street",
      postcode: null,
      customer: { id: "cust-1", name: "John Smith", email: null, phone: null, paymentMethod: null },
    },
    round: null,
    technician: null,
    service: null,
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.invoice.create as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-new",
    invoiceNumber: "INV-2026-001",
    status: "DRAFT",
    sentToCustomer: false,
    sentAt: null,
  });
  const svc = createInvoiceService(prisma);
  const result = await svc.createInvoice({ visitId: "visit-1", sendEmail: false });
  expect(result.status).toBe("DRAFT");
});

it("sendInvoice is a function", () => {
  const svc = createInvoiceService(makePrisma());
  expect(typeof svc.sendInvoice).toBe("function");
});

it("sendInvoice throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createInvoiceService(prisma);
  await expect(svc.sendInvoice("bad-id")).rejects.toMatchObject({ statusCode: 404 });
});

it("sendInvoice throws 409 when invoice is already SENT", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    status: "SENT",
    customer: { name: "John Smith", email: "j@example.com" },
    visit: null,
    createdAt: new Date(),
    dueDate: null,
    invoiceNumber: "INV-2026-001",
    amount: { toNumber: () => 35 },
  });
  const svc = createInvoiceService(prisma);
  await expect(svc.sendInvoice("inv-1")).rejects.toMatchObject({ statusCode: 409 });
});

it("sendInvoice throws 400 when customer has no email", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    status: "DRAFT",
    customer: { name: "John Smith", email: null },
    visit: null,
    createdAt: new Date(),
    dueDate: null,
    invoiceNumber: "INV-2026-001",
    amount: { toNumber: () => 35 },
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createInvoiceService(prisma);
  await expect(svc.sendInvoice("inv-1")).rejects.toMatchObject({ statusCode: 400 });
});

it("getInvoice is a function", () => {
  const svc = createInvoiceService(makePrisma());
  expect(typeof svc.getInvoice).toBe("function");
});

it("getInvoice throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const svc = createInvoiceService(prisma);
  await expect(svc.getInvoice("bad-id")).rejects.toMatchObject({ statusCode: 404 });
});

it("listCustomerInvoices is a function", () => {
  const svc = createInvoiceService(makePrisma());
  expect(typeof svc.listCustomerInvoices).toBe("function");
});

it("listCustomerInvoices returns an array", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const svc = createInvoiceService(prisma);
  const result = await svc.listCustomerInvoices("cust-1");
  expect(Array.isArray(result)).toBe(true);
});

it("listCustomerInvoices returns invoices for the customer", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "inv-1", invoiceNumber: "INV-2026-001", status: "SENT", amount: { toNumber: () => 35 }, dueDate: null, sentToCustomer: true, sentAt: new Date(), createdAt: new Date(), visitId: "visit-1" },
  ]);
  const svc = createInvoiceService(prisma);
  const result = await svc.listCustomerInvoices("cust-1");
  expect(result).toHaveLength(1);
  expect(result[0].invoiceNumber).toBe("INV-2026-001");
});

it("getInvoice returns the invoice id and amount", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    invoiceNumber: "INV-2026-001",
    status: "SENT",
    amount: { toNumber: () => 35 },
    dueDate: null,
    notes: null,
    sentToCustomer: true,
    sentAt: new Date(),
    createdAt: new Date(),
    customerId: "cust-1",
    visitId: "visit-1",
  });
  const svc = createInvoiceService(prisma);
  const result = await svc.getInvoice("inv-1");
  expect(result.id).toBe("inv-1");
  expect(result.amount).toBe(35);
});

it("sendInvoice returns status SENT after sending", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    status: "DRAFT",
    customer: { name: "John Smith", email: "j@example.com" },
    visit: null,
    createdAt: new Date(),
    dueDate: null,
    invoiceNumber: "INV-2026-001",
    amount: { toNumber: () => 35 },
  });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.invoice.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "inv-1",
    invoiceNumber: "INV-2026-001",
    status: "SENT",
    sentToCustomer: true,
    sentAt: new Date(),
  });
  const svc = createInvoiceService(prisma);
  const result = await svc.sendInvoice("inv-1");
  expect(result.status).toBe("SENT");
  expect(result.sentToCustomer).toBe(true);
});
