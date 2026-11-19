import { describe, expect, it, vi } from "vitest";
import { Prisma, VisitStatus } from "../../generated/tenant-client";

// GET /customers/:id/visits: services billed together show the shared invoice and payment
// (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.5).

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { createCustomerService } from "../customer.service";

const date = new Date("2026-11-19T00:00:00.000Z");
const base = {
  date,
  propertyId: "p1",
  technicianId: "t1",
  cancelReason: null,
  notes: null,
  round: { name: "Monday" },
  price: new Prisma.Decimal(20),
  service: { name: "Window clean" },
  invoice: null,
  invoiceLine: null,
  payment: null,
  billedWith: null,
  billedWithVisitId: null,
};

it("rows carry the service, price, stop, shared invoice and the anchor's payment status", async () => {
  const prisma: any = {
    customer: { findUnique: vi.fn().mockResolvedValue({ id: "c1" }) },
    visit: {
      count: vi.fn().mockResolvedValue(2),
      findMany: vi.fn().mockResolvedValue([
        { ...base, id: "v1", status: VisitStatus.COMPLETED, invoice: { id: "inv1" }, payment: { status: "PAID" } },
        {
          ...base,
          id: "v2",
          status: VisitStatus.COMPLETED,
          price: new Prisma.Decimal(10),
          service: { name: "Gutter clear" },
          invoiceLine: { invoiceId: "inv1" },
          billedWithVisitId: "v1",
          billedWith: { payment: { status: "PAID" } },
        },
      ]),
    },
  };
  const page = await createCustomerService(prisma).getVisitHistory("c1", 1, 20);
  expect(page.rows).toEqual([
    expect.objectContaining({
      visitId: "v1",
      serviceName: "Window clean",
      price: 20,
      stopKey: "p1|2026-11-19|t1",
      invoiceId: "inv1",
      billedWithVisitId: null,
      paymentStatus: "PAID",
    }),
    expect.objectContaining({
      visitId: "v2",
      serviceName: "Gutter clear",
      price: 10,
      stopKey: "p1|2026-11-19|t1",
      invoiceId: "inv1",
      billedWithVisitId: "v1",
      paymentStatus: "PAID",
    }),
  ]);
  expect(prisma.visit.findMany.mock.calls[0][0].include).toEqual(
    expect.objectContaining({
      service: { select: { name: true } },
      invoice: { select: { id: true } },
      invoiceLine: { select: { invoiceId: true } },
      billedWith: { select: { payment: { select: { status: true } } } },
    }),
  );
});
