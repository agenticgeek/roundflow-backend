import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/email", () => ({}));
vi.mock("../message.service", () => ({ createMessageService: vi.fn() }));
const releaseHoldIfSettled = vi.fn();
vi.mock("../payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));

import { createInvoiceService } from "../invoice.service";
import { AppError } from "../../lib/app-error";

const visit = (extra: Record<string, unknown> = {}) => ({
  id: "v1",
  status: "COMPLETED",
  paymentHold: false,
  date: new Date("2026-11-02T00:00:00Z"),
  price: { toNumber: () => 20 },
  paymentMethod: null,
  invoice: null,
  payment: null,
  property: { addressLine: "1 High St", postcode: "X1", customer: { id: "c1", name: "Jo", holdNextClean: false } },
  ...extra,
});

function makePrisma(v: unknown) {
  const prisma: any = {
    invoice: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "inv1", invoiceNumber: "INV-1", sentToCustomer: false, sentAt: null, dueDate: data.dueDate, ...data })),
    },
    visit: { findUnique: vi.fn().mockResolvedValue(v) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ vatInInvoices: true, vatRate: 20, invoiceDueDays: 7 }) },
    $executeRaw: vi.fn(),
    $transaction: vi.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

it("A2: a visit whose payment is PAID gets a PAID invoice with the payment's paidAt and releases a settled hold", async () => {
  const paidAt = new Date("2026-11-02T10:00:00Z");
  const prisma = makePrisma(visit({ payment: { status: "PAID", paidAt } }));
  const out = await createInvoiceService(prisma).createInvoice({ visitId: "v1" } as never);
  const data = prisma.invoice.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ status: "PAID", paidAt, amount: expect.anything() });
  expect(out.total).toBe(24); // VAT-inclusive
  expect(releaseHoldIfSettled).toHaveBeenCalledWith(prisma, "c1");
});

it("A2: a PAID payment without paidAt falls back to now; an unpaid/pending payment stays DRAFT", async () => {
  const prisma = makePrisma(visit({ payment: { status: "PAID", paidAt: null } }));
  await createInvoiceService(prisma).createInvoice({ visitId: "v1" } as never);
  expect(prisma.invoice.create.mock.calls[0][0].data.paidAt).toBeInstanceOf(Date);

  const pending = makePrisma(visit({ payment: { status: "PENDING", paidAt: null } }));
  await createInvoiceService(pending).createInvoice({ visitId: "v1" } as never);
  expect(pending.invoice.create.mock.calls[0][0].data).toMatchObject({ status: "DRAFT", paidAt: null });
  expect(releaseHoldIfSettled).toHaveBeenCalledTimes(1);
});

it("A1: autoCreateForCompletedVisit creates the invoice and reports its status", async () => {
  const prisma = makePrisma(visit());
  await expect(createInvoiceService(prisma).autoCreateForCompletedVisit("v1")).resolves.toEqual({ invoiceId: "inv1", status: "DRAFT" });
});

it("A1: is a no-op for held visits/customers, already-invoiced visits and lost races", async () => {
  const held = makePrisma(visit({ paymentHold: true }));
  await expect(createInvoiceService(held).autoCreateForCompletedVisit("v1")).resolves.toBeNull();
  const customerHeld = makePrisma(visit({ property: { addressLine: "x", postcode: "y", customer: { id: "c1", name: "Jo", holdNextClean: true } } }));
  await expect(createInvoiceService(customerHeld).autoCreateForCompletedVisit("v1")).resolves.toBeNull();
  expect(held.invoice.create).not.toHaveBeenCalled();

  const done = makePrisma(visit({ invoice: { id: "inv0" } }));
  await expect(createInvoiceService(done).autoCreateForCompletedVisit("v1")).resolves.toBeNull();

  const race = makePrisma(visit());
  race.invoice.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
  await expect(createInvoiceService(race).autoCreateForCompletedVisit("v1")).resolves.toBeNull();
});

it("A1: real failures propagate", async () => {
  const prisma = makePrisma(visit());
  prisma.invoice.create.mockRejectedValue(new Error("db down"));
  await expect(createInvoiceService(prisma).autoCreateForCompletedVisit("v1")).rejects.toThrow("db down");
  prisma.visit.findUnique.mockResolvedValue(null);
  await expect(createInvoiceService(prisma).autoCreateForCompletedVisit("v1")).rejects.toBeInstanceOf(AppError);
});
