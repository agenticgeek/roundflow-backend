import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
}));

const syncCustomerToGhl = vi.fn().mockResolvedValue(undefined);
const applyGhlTags = vi.fn().mockResolvedValue(undefined);
const applyGhlCustomFields = vi.fn().mockResolvedValue(undefined);
vi.mock("../../integrations/ghl/sync", () => ({
  syncCustomerToGhl: (...args: unknown[]) => syncCustomerToGhl(...args),
  applyGhlTags: (...args: unknown[]) => applyGhlTags(...args),
  applyGhlCustomFields: (...args: unknown[]) => applyGhlCustomFields(...args),
}));

const computeBalanceOwed = vi.fn().mockResolvedValue(42);
vi.mock("../../services/payment.service", () => ({
  computeBalanceOwed: (...args: unknown[]) => computeBalanceOwed(...args),
}));

import { runOutboxWorker } from "../outboxWorker";

type Row = { id: string; eventType: string; payload: unknown; attempts: number };

function makeTp(rows: Row[]) {
  return {
    integrationOutbox: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({}),
    },
    visit: { findUnique: vi.fn().mockResolvedValue(null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  computeBalanceOwed.mockResolvedValue(42);
});

describe("runOutboxWorker", () => {
  it("does nothing when no tenants are GHL-connected", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runOutboxWorker();
    expect(getTenantPrismaForSchema).not.toHaveBeenCalled();
  });

  it("queries only GHL-connected tenants", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runOutboxWorker();
    expect(tenantFindMany).toHaveBeenCalledWith({
      where: { ghlLocationId: { not: null } },
      select: { schemaName: true },
    });
  });

  it("calls syncCustomerToGhl for a customer.synced row and marks it sent", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "customer.synced", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(syncCustomerToGhl).toHaveBeenCalledWith(tp, "cust-1");
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { status: "sent", processedAt: expect.any(Date) },
    });
  });

  it("applies visit-completed tag only when the payload has no visitId", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "visit.completed", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlTags).toHaveBeenCalledWith(tp, "cust-1", ["visit-completed"]);
    expect(tp.visit.findUnique).not.toHaveBeenCalled();
    expect(applyGhlCustomFields).not.toHaveBeenCalled();
  });

  it("writes last_clean_date/round_name/technician_name/balance_owed when visit.completed has a visitId", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = {
      id: "row-1",
      eventType: "visit.completed",
      payload: { customerId: "cust-1", visitId: "visit-1" },
      attempts: 0,
    };
    const tp = makeTp([row]);
    tp.visit.findUnique.mockResolvedValue({
      completedAt: new Date("2026-03-05T00:00:00Z"),
      round: { name: "Tuesday Round" },
      technician: { name: "Alex" },
    });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(tp.visit.findUnique).toHaveBeenCalledWith({
      where: { id: "visit-1" },
      select: { completedAt: true, round: { select: { name: true } }, technician: { select: { name: true } } },
    });
    expect(applyGhlCustomFields).toHaveBeenCalledWith(tp, "cust-1", {
      balance_owed: 42,
      last_clean_date: "2026-03-05",
      round_name: "Tuesday Round",
      technician_name: "Alex",
    });
  });

  it("only writes balance_owed when the visit has no round/technician/completedAt", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = {
      id: "row-1",
      eventType: "visit.completed",
      payload: { customerId: "cust-1", visitId: "visit-1" },
      attempts: 0,
    };
    const tp = makeTp([row]);
    tp.visit.findUnique.mockResolvedValue({ completedAt: null, round: null, technician: null });
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlCustomFields).toHaveBeenCalledWith(tp, "cust-1", { balance_owed: 42 });
  });

  it("writes next_clean_date for visit.scheduled", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = {
      id: "row-1",
      eventType: "visit.scheduled",
      payload: { customerId: "cust-1", nextCleanDate: "2026-04-01" },
      attempts: 0,
    };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlCustomFields).toHaveBeenCalledWith(tp, "cust-1", { next_clean_date: "2026-04-01" });
  });

  it("does nothing extra for visit.scheduled when the payload has no nextCleanDate", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "visit.scheduled", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlCustomFields).not.toHaveBeenCalled();
  });

  it.each([
    ["payment.collected", ["payment-collected"], ["debt-overdue", "payment-failed"]],
    ["payment.failed", ["payment-failed"], undefined],
    ["debt.overdue", ["debt-overdue"], undefined],
  ])("applies the right GHL tags and writes balance_owed for %s", async (eventType, addTags, removeTags) => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType, payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    if (removeTags) {
      expect(applyGhlTags).toHaveBeenCalledWith(tp, "cust-1", addTags, removeTags);
    } else {
      expect(applyGhlTags).toHaveBeenCalledWith(tp, "cust-1", addTags);
    }
    expect(applyGhlCustomFields).toHaveBeenCalledWith(tp, "cust-1", { balance_owed: 42 });
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { status: "sent", processedAt: expect.any(Date) },
    });
  });

  it("applies the has-open-complaint tag for complaint.logged", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "complaint.logged", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlTags).toHaveBeenCalledWith(tp, "cust-1", ["has-open-complaint"]);
  });

  it("removes the has-open-complaint tag for complaint.resolved", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "complaint.resolved", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(applyGhlTags).toHaveBeenCalledWith(tp, "cust-1", [], ["has-open-complaint"]);
  });

  it("warns and still marks the row sent for an unknown eventType", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "mystery.event", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown eventType: mystery.event"));
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { status: "sent", processedAt: expect.any(Date) },
    });
    warnSpy.mockRestore();
  });

  it("retries (stays pending) when the payload is missing customerId", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "visit.completed", payload: {}, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { attempts: 1, lastError: expect.stringContaining("payload missing customerId"), status: "pending" },
    });
  });

  it("marks the row dead after MAX_ATTEMPTS failures and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "visit.completed", payload: {}, attempts: 4 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: {
        attempts: 5,
        lastError: expect.stringContaining("payload missing customerId"),
        status: "dead",
        processedAt: expect.any(Date),
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("row row-1 (visit.completed) dead after 5 attempts:"),
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });

  it("processes multiple GHL-connected tenants independently", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const row1: Row = { id: "row-1", eventType: "complaint.logged", payload: { customerId: "cust-1" }, attempts: 0 };
    const row2: Row = { id: "row-2", eventType: "complaint.logged", payload: { customerId: "cust-2" }, attempts: 0 };
    const tp1 = makeTp([row1]);
    const tp2 = makeTp([row2]);
    getTenantPrismaForSchema.mockImplementation((schemaName: string) => (schemaName === "t_1" ? tp1 : tp2));

    await runOutboxWorker();

    expect(applyGhlTags).toHaveBeenCalledWith(tp1, "cust-1", ["has-open-complaint"]);
    expect(applyGhlTags).toHaveBeenCalledWith(tp2, "cust-2", ["has-open-complaint"]);
  });
});
