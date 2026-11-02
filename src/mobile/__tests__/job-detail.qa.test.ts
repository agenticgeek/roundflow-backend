import { it, expect, vi, beforeEach } from "vitest";

const releaseHoldIfSettled = vi.fn();
vi.mock("../../services/payment-hold", () => ({ releaseHoldIfSettled: (...a: unknown[]) => releaseHoldIfSettled(...a) }));

import { createJobDetailService } from "../services/job-detail.service";
import { requireTechnician } from "../ownership";

beforeEach(() => vi.clearAllMocks());

function makePrisma(settings: Record<string, unknown> | null) {
  return {
    visit: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    customer: { findUnique: vi.fn().mockResolvedValue({ holdNextClean: false }), update: vi.fn() },
    invoice: { findMany: vi.fn(), updateMany: vi.fn((a: unknown) => a) },
    payment: { create: vi.fn((a: unknown) => a) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  } as any;
}

const visit = {
  id: "v1", status: "SCHEDULED", date: new Date(), roundId: null, propertyId: "p1", paymentMethod: null, servicePlan: null,
  price: { toNumber: () => 20 },
  property: {
    id: "p1", accessNotes: "Gate code 4521", riskNotes: "Large dog",
    customer: { id: "c1", name: "A", badDebt: false, paymentMethod: "CASH", invoices: [] }, notes: [],
  },
};

it("A3: job detail returns the VAT-inclusive total the technician should take", async () => {
  const prisma = makePrisma({ vatInInvoices: true, vatRate: 20, debtHoldEnabled: false });
  prisma.visit.findUnique.mockResolvedValue(visit);
  const out = await createJobDetailService(prisma).getVisitDetail("v1");
  expect(out).toMatchObject({ vatAmount: 4, vatRate: 20, grossTotal: 24 });
});

it("A3: no VAT when the business does not add VAT to invoices", async () => {
  const prisma = makePrisma({ vatInInvoices: false, vatRate: 20, debtHoldEnabled: false });
  prisma.visit.findUnique.mockResolvedValue(visit);
  const out = await createJobDetailService(prisma).getVisitDetail("v1");
  expect(out).toMatchObject({ vatAmount: 0, vatRate: 0, grossTotal: 20 });
});

it("C2: access and risk notes from the property form reach the technician", async () => {
  const prisma = makePrisma(null);
  prisma.visit.findUnique.mockResolvedValue(visit);
  const out = await createJobDetailService(prisma).getVisitDetail("v1");
  expect(out.property).toMatchObject({ accessNotes: "Gate code 4521", riskNotes: "Large dog" });
  expect(prisma.visit.findUnique.mock.calls[0][0].include.property.select).toMatchObject({ accessNotes: true, riskNotes: true });
});

it("A8: collecting a debt in cash stamps paidAt on the invoices and releases a settled hold", async () => {
  const prisma = makePrisma(null);
  prisma.visit.findUnique.mockResolvedValue({ property: { customer: { id: "c1", name: "Tom" } } });
  prisma.invoice.findMany.mockResolvedValue([{ id: "i1", amount: { toNumber: () => 36 } }]);
  await createJobDetailService(prisma).collectDebtPayment("v1", { method: "CASH" });
  const upd = prisma.invoice.updateMany.mock.calls[0][0];
  expect(upd.data).toMatchObject({ status: "PAID", paidAt: expect.any(Date) });
  expect(prisma.payment.create.mock.calls[0][0].data.paidAt).toBe(upd.data.paidAt);
  expect(releaseHoldIfSettled).toHaveBeenCalledWith(prisma, "c1");
});

function res() {
  const r: any = { status: vi.fn(() => r), json: vi.fn(() => r) };
  return r;
}

it("C1: a deactivated technician is refused with 403 TECHNICIAN_INACTIVE", async () => {
  const tp = { technician: { findUnique: vi.fn().mockResolvedValue({ id: "t1", active: false }) } };
  const r = res();
  const next = vi.fn();
  await requireTechnician({ profile: { id: "p1", role: "TECHNICIAN" }, tenantPrisma: tp } as any, r, next);
  expect(r.status).toHaveBeenCalledWith(403);
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: "TECHNICIAN_INACTIVE" }));
  expect(next).not.toHaveBeenCalled();
});
