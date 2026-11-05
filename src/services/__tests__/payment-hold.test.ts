import { describe, it, expect, vi } from "vitest";
import { holdNextVisits, releaseHeldVisits, releaseHoldIfSettled } from "../payment-hold";

function makeTp() {
  return {
    property: { findMany: vi.fn().mockResolvedValue([]) },
    visit: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ debtHoldEnabled: true }) },
    customer: {
      findUnique: vi.fn().mockResolvedValue({ holdNextClean: true }),
      update: vi.fn().mockResolvedValue({}),
    },
    invoice: { count: vi.fn().mockResolvedValue(0) },
  };
}

const NOW = new Date("2026-10-30T15:30:00Z");
const TODAY = new Date("2026-10-30T00:00:00Z");

describe("holdNextVisits", () => {
  it("flags the next SCHEDULED visit on each ACTIVE property, skipping properties with none", async () => {
    const tp = makeTp();
    tp.property.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
    tp.visit.findFirst
      .mockResolvedValueOnce({ id: "v1" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "v3" });

    const held = await holdNextVisits(tp as never, "c1", NOW);

    expect(held).toBe(2);
    expect(tp.property.findMany).toHaveBeenCalledWith({ where: { customerId: "c1", status: "ACTIVE" }, select: { id: true } });
    expect(tp.visit.findFirst).toHaveBeenCalledWith({
      where: { propertyId: "p1", status: "SCHEDULED", date: { gte: TODAY } },
      orderBy: { date: "asc" },
      select: { id: true },
    });
    expect(tp.visit.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { paymentHold: true } });
    expect(tp.visit.update).toHaveBeenCalledWith({ where: { id: "v3" }, data: { paymentHold: true } });
  });

  it("returns 0 for a customer with no future visits (default clock)", async () => {
    const tp = makeTp();
    tp.property.findMany.mockResolvedValue([{ id: "p1" }]);
    await expect(holdNextVisits(tp as never, "c1")).resolves.toBe(0);
    expect(tp.visit.update).not.toHaveBeenCalled();
  });
});

describe("releaseHeldVisits", () => {
  it("clears paymentHold on future SCHEDULED visits", async () => {
    const tp = makeTp();
    tp.visit.updateMany.mockResolvedValue({ count: 3 });
    await expect(releaseHeldVisits(tp as never, "c1", NOW)).resolves.toBe(3);
    expect(tp.visit.updateMany).toHaveBeenCalledWith({
      where: { property: { customerId: "c1" }, status: "SCHEDULED", date: { gte: TODAY }, paymentHold: true },
      data: { paymentHold: false },
    });
  });

  it("uses the current time by default", async () => {
    const tp = makeTp();
    await expect(releaseHeldVisits(tp as never, "c1")).resolves.toBe(0);
  });
});

describe("releaseHoldIfSettled", () => {
  it("does nothing when debt hold is disabled or settings are missing", async () => {
    const tp = makeTp();
    tp.businessSettings.findFirst.mockResolvedValueOnce({ debtHoldEnabled: false }).mockResolvedValueOnce(null);
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(false);
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(false);
    expect(tp.customer.update).not.toHaveBeenCalled();
  });

  it("does nothing when the customer isn't on hold (or doesn't exist)", async () => {
    const tp = makeTp();
    tp.customer.findUnique.mockResolvedValueOnce({ holdNextClean: false }).mockResolvedValueOnce(null);
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(false);
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(false);
    expect(tp.customer.update).not.toHaveBeenCalled();
  });

  it("keeps the hold while another invoice is still unpaid", async () => {
    const tp = makeTp();
    tp.invoice.count.mockResolvedValue(1);
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(false);
    expect(tp.invoice.count).toHaveBeenCalledWith({ where: { customerId: "c1", status: "SENT" } });
    expect(tp.customer.update).not.toHaveBeenCalled();
  });

  it("releases the customer and their visits once nothing is owed", async () => {
    const tp = makeTp();
    await expect(releaseHoldIfSettled(tp as never, "c1")).resolves.toBe(true);
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { holdNextClean: false, holdReason: null, holdSince: null },
    });
    expect(tp.visit.updateMany).toHaveBeenCalled();
  });
});
