import { it, expect, vi } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...a),
}));

import { listGeneratedHeldVisits, listGeneratedHeldVisitsForTenant } from "../heldVisitsReport";

const row = {
  id: "v1",
  date: new Date("2026-11-10T00:00:00Z"),
  status: "SCHEDULED",
  propertyId: "p1",
  property: {
    addressLine: "1 High St",
    customer: { id: "c1", name: "Jo", holdNextClean: false, holdReason: null, holdSince: null },
  },
};

it("lists generated held visits read-only and maps the customer hold state", async () => {
  const findMany = vi.fn().mockResolvedValue([
    row,
    { ...row, id: "v2", property: { ...row.property, customer: { ...row.property.customer, holdNextClean: true, holdReason: "Debt", holdSince: new Date("2026-10-01T00:00:00Z") } } },
  ]);
  const out = await listGeneratedHeldVisitsForTenant({ visit: { findMany } } as never);
  expect(findMany.mock.calls[0][0].where).toEqual({
    paymentHold: true,
    status: "SCHEDULED",
    servicePlanId: { not: null },
    isOneOff: false,
    complaintId: null,
  });
  expect(out[0]).toMatchObject({ visitId: "v1", date: "2026-11-10", customerOnHold: false, holdSince: null });
  expect(out[1]).toMatchObject({ customerOnHold: true, holdReason: "Debt", holdSince: "2026-10-01T00:00:00.000Z" });
});

it("runs per tenant", async () => {
  tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
  getTenantPrismaForSchema.mockReturnValue({ visit: { findMany: vi.fn().mockResolvedValue([]) } });
  await expect(listGeneratedHeldVisits()).resolves.toEqual([{ schemaName: "t_a", result: [] }]);
});
