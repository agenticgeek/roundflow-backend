import { it, expect, vi } from "vitest";

vi.mock("../../lib/email", () => ({
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  sendTemplatedEmail: vi.fn().mockResolvedValue(undefined),
}));

import { createDebtService } from "../debt.service";

function makePrisma() {
  return {
    invoice: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    customer: { findUnique: vi.fn(), update: vi.fn() },
    visit: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    message: { create: vi.fn(), findFirst: vi.fn() },
    businessSettings: { findFirst: vi.fn() },
  } as unknown as Parameters<typeof createDebtService>[0];
}

it("createDebtService returns an object", () => {
  const svc = createDebtService(makePrisma());
  expect(svc).toBeDefined();
});

it("getKpis is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.getKpis).toBe("function");
});

it("getKpis result has totalOutstandings", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect("totalOutstandings" in result).toBe(true);
});

it("getKpis badDebt invoices are excluded from totalOutstandings", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: null, amount: { toNumber: () => 35 }, customer: { badDebt: false, holdNextClean: false } },
    { customerId: "c2", visitId: null, amount: { toNumber: () => 100 }, customer: { badDebt: true, holdNextClean: false } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandings).toBe(35);
});

it("getKpis result has badDebt field", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect("badDebt" in result).toBe(true);
});

it("getKpis badDebt sums bad-debt invoice amounts", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: null, amount: { toNumber: () => 100 }, customer: { badDebt: true, holdNextClean: false } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.badDebt).toBe(100);
});

it("getKpis result has failedGoCardless field", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect("failedGoCardless" in result).toBe(true);
});

it("getKpis failedGoCardless counts invoices with a FAILED GC payment", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: "v1", amount: { toNumber: () => 35 }, customer: { badDebt: false, holdNextClean: false } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ visitId: "v1" }]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.failedGoCardless).toBe(1);
});

it("getKpis result has dueBeforeClean field", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect("dueBeforeClean" in result).toBe(true);
});

it("getKpis dueBeforeClean counts invoices where customer has an upcoming visit", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: null, amount: { toNumber: () => 35 }, customer: { badDebt: false, holdNextClean: false } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { property: { customerId: "c1" } },
  ]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.dueBeforeClean).toBe(1);
});

it("getKpis result has holdNextClean field", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect("holdNextClean" in result).toBe(true);
});

it("getKpis holdNextClean counts customers with holdNextClean flag", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: null, amount: { toNumber: () => 35 }, customer: { badDebt: false, holdNextClean: true } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.holdNextClean).toBe(1);
});

it("getBoard is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.getBoard).toBe("function");
});

it("getBoard returns an array", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.message.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(Array.isArray(result)).toBe(true);
});

it("getBoard BAD_DEBT returns only bad-debt invoices", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "inv-1", invoiceNumber: "INV-2026-001", amount: { toNumber: () => 35 }, dueDate: null, customerId: "c1", customer: { id: "c1", name: "John", email: null, paymentMethod: null, badDebt: true, holdNextClean: false }, visit: null },
    { id: "inv-2", invoiceNumber: "INV-2026-002", amount: { toNumber: () => 50 }, dueDate: null, customerId: "c2", customer: { id: "c2", name: "Jane", email: null, paymentMethod: null, badDebt: false, holdNextClean: false }, visit: null },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.message.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const result = await createDebtService(prisma).getBoard("BAD_DEBT");
  expect(result).toHaveLength(1);
  expect(result[0].customerName).toBe("John");
});

it("getBoard INVOICE_SENT excludes bad-debt invoices", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "inv-1", invoiceNumber: "INV-2026-001", amount: { toNumber: () => 35 }, dueDate: null, customerId: "c1", customer: { id: "c1", name: "John", email: null, paymentMethod: null, badDebt: true, holdNextClean: false }, visit: null },
    { id: "inv-2", invoiceNumber: "INV-2026-002", amount: { toNumber: () => 50 }, dueDate: null, customerId: "c2", customer: { id: "c2", name: "Jane", email: null, paymentMethod: null, badDebt: false, holdNextClean: false }, visit: null },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.message.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  const result = await createDebtService(prisma).getBoard("INVOICE_SENT");
  expect(result).toHaveLength(1);
  expect(result[0].customerName).toBe("Jane");
});

it("sendReminder is a function", () => {
  const svc = createDebtService(makePrisma());
  expect(typeof svc.sendReminder).toBe("function");
});

it("sendReminder throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendReminder("bad-id", "EMAIL", "Hi")).rejects.toMatchObject({ statusCode: 404 });
});

it("sendReminder throws 400 when channel is EMAIL and customer has no email", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: null } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendReminder("inv-1", "EMAIL", "Hi")).rejects.toMatchObject({ statusCode: 400 });
});

it("sendReminder records a Message and returns its id", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: "j@example.com" } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.message.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-1" });
  const result = await createDebtService(prisma).sendReminder("inv-1", "EMAIL", "Hi");
  expect(result.id).toBe("msg-1");
});

it("flagBadDebt is a function", () => {
  expect(typeof createDebtService(makePrisma()).flagBadDebt).toBe("function");
});

it("flagBadDebt throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).flagBadDebt("bad-id", true)).rejects.toMatchObject({ statusCode: 404 });
});

it("flagBadDebt sets badDebt on the customer and returns it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", badDebt: true });
  const result = await createDebtService(prisma).flagBadDebt("inv-1", true);
  expect(result.badDebt).toBe(true);
});

it("flagHold is a function", () => {
  expect(typeof createDebtService(makePrisma()).flagHold).toBe("function");
});

it("flagHold throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).flagHold("bad-id", true)).rejects.toMatchObject({ statusCode: 404 });
});

it("flagHold sets holdNextClean on the customer and returns it", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", customerId: "c1" });
  (prisma.customer.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", holdNextClean: true });
  const result = await createDebtService(prisma).flagHold("inv-1", true);
  expect(result.holdNextClean).toBe(true);
});

it("sendPaymentLink is a function", () => {
  expect(typeof createDebtService(makePrisma()).sendPaymentLink).toBe("function");
});

it("sendPaymentLink throws 404 when invoice does not exist", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendPaymentLink("bad-id", "Pay now")).rejects.toMatchObject({ statusCode: 404 });
});

it("sendPaymentLink throws 400 when customer has no email", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: null } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  await expect(createDebtService(prisma).sendPaymentLink("inv-1", "Pay now")).rejects.toMatchObject({ statusCode: 400 });
});

it("sendPaymentLink records a Message and returns its id", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-2026-001", customerId: "c1", customer: { id: "c1", name: "John", email: "j@example.com" } });
  (prisma.businessSettings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (prisma.message.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "msg-2" });
  const result = await createDebtService(prisma).sendPaymentLink("inv-1", "Pay now");
  expect(result.id).toBe("msg-2");
});

it("getKpis totalOutstandings sums SENT invoice amounts", async () => {
  const prisma = makePrisma();
  (prisma.invoice.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { customerId: "c1", visitId: null, amount: { toNumber: () => 35 }, customer: { badDebt: false, holdNextClean: false } },
    { customerId: "c2", visitId: null, amount: { toNumber: () => 50 }, customer: { badDebt: false, holdNextClean: false } },
  ]);
  (prisma.payment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.visit.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  const result = await createDebtService(prisma).getKpis();
  expect(result.totalOutstandings).toBe(85);
});
