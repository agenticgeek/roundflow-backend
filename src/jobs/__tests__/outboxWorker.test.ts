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

const messageSend = vi.fn().mockResolvedValue({ status: "sent", messageId: "m1", channel: "SMS" });
vi.mock("../../services/message.service", () => ({
  createMessageService: () => ({ send: (...args: unknown[]) => messageSend(...args) }),
}));

import { runOutboxWorker } from "../outboxWorker";

type Row = { id: string; eventType: string; payload: unknown; attempts: number };

function makeTp(rows: Row[]) {
  return {
    integrationOutbox: {
      findMany: vi.fn().mockResolvedValue(rows),
      update: vi.fn().mockResolvedValue({}),
    },
    visit: { findUnique: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn> },
    customer: { findUnique: vi.fn().mockResolvedValue({ messagesOptOut: false }) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ businessName: "Shine Ltd" }) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

type Tp = ReturnType<typeof makeTp>;
const SENT = { status: "sent", processedAt: expect.any(Date) };

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

  describe("message.send (pre-clean reminders)", () => {
    const payload = {
      customerId: "cust-1", visitId: "visit-1", channel: "SMS", body: "Hi Jo", templateId: "tpl-1", reason: "PRE_CLEAN_REMINDER",
    };
    const run = async (p: Record<string, unknown>, setup?: (tp: Tp) => void) => {
      tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
      const tp = makeTp([{ id: "row-1", eventType: "message.send", payload: p, attempts: 0 }]);
      tp.visit.findUnique.mockResolvedValue({ status: "SCHEDULED" });
      setup?.(tp);
      getTenantPrismaForSchema.mockReturnValue(tp);
      await runOutboxWorker();
      return tp;
    };

    it("sends the pre-rendered body via the message service and marks the row sent", async () => {
      const tp = await run(payload);
      expect(tp.customer.findUnique).toHaveBeenCalledWith({ where: { id: "cust-1" }, select: { messagesOptOut: true } });
      expect(tp.visit.findUnique).toHaveBeenCalledWith({ where: { id: "visit-1" }, select: { status: true } });
      expect(messageSend).toHaveBeenCalledWith({ customerId: "cust-1", channel: "SMS", body: "Hi Jo", templateId: "tpl-1" });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
    });

    it("sends without a visit check or template when the payload has neither", async () => {
      const tp = await run({ customerId: "cust-1", body: "Hi" });
      expect(tp.visit.findUnique).not.toHaveBeenCalled();
      expect(messageSend).toHaveBeenCalledWith({ customerId: "cust-1", channel: undefined, body: "Hi", templateId: null });
    });

    it.each([
      ["the customer opted out", (tp: Tp) => tp.customer.findUnique.mockResolvedValue({ messagesOptOut: true })],
      ["the customer no longer exists", (tp: Tp) => tp.customer.findUnique.mockResolvedValue(null)],
      ["the visit is no longer scheduled", (tp: Tp) => tp.visit.findUnique.mockResolvedValue({ status: "CANCELLED" })],
      ["the visit was deleted", (tp: Tp) => tp.visit.findUnique.mockResolvedValue(null)],
    ])("skips (marks sent, no send) when %s", async (_label, setup) => {
      const tp = await run(payload, setup);
      expect(messageSend).not.toHaveBeenCalled();
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
    });

    it("retries when the body is missing or the send fails", async () => {
      let tp = await run({ customerId: "cust-1" });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { attempts: 1, lastError: expect.stringContaining("payload missing body"), status: "pending" },
      });
      messageSend.mockRejectedValueOnce(new Error("GHL down"));
      tp = await run(payload);
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { attempts: 1, lastError: expect.stringContaining("GHL down"), status: "pending" },
      });
    });
  });

  describe("message.visit_completed", () => {
    const visit = {
      completedAt: new Date("2026-10-30T10:00:00Z") as Date | null,
      date: new Date("2026-10-29T00:00:00Z"),
      property: { addressLine: "1 High St", customer: { name: "Jo Bloggs" } },
      round: { name: "Monday" } as { name: string } | null,
      technician: { name: "Alex" } as { name: string } | null,
    };
    const run = async (p: Record<string, unknown>, setup?: (tp: Tp) => void) => {
      tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
      const tp = makeTp([{ id: "row-1", eventType: "message.visit_completed", payload: p, attempts: 0 }]);
      tp.visit.findUnique.mockResolvedValue(visit);
      setup?.(tp);
      getTenantPrismaForSchema.mockReturnValue(tp);
      await runOutboxWorker();
      return tp;
    };

    it("renders the tenant template and sends it", async () => {
      const tp = await run({ customerId: "cust-1", visitId: "visit-1", template: "Visit completed" }, (t) =>
        t.messageTemplate.findFirst.mockResolvedValue({
          id: "tpl-9",
          body: "Hi [Customer Name] ({{firstName}}), {{address}} done {{date}} by {{technicianName}} on {{roundName}} - {{businessName}}",
        })
      );
      expect(tp.messageTemplate.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: "Visit completed", mode: "insensitive" } },
        select: { id: true, body: true },
      });
      expect(messageSend).toHaveBeenCalledWith({
        customerId: "cust-1",
        body: "Hi Jo Bloggs (Jo), 1 High St done 2026-10-30 by Alex on Monday - Shine Ltd",
        templateId: "tpl-9",
      });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
    });

    it("falls back to the built-in body, visit date and blanks when template/round/technician/settings are missing", async () => {
      await run({ customerId: "cust-1", visitId: "visit-1" }, (t) => {
        t.visit.findUnique.mockResolvedValue({ ...visit, completedAt: null, round: null, technician: null });
        t.businessSettings.findFirst.mockResolvedValue(null);
        t.messageTemplate.findFirst.mockResolvedValue({ id: "tpl-2", body: "{{date}}|{{roundName}}|{{technicianName}}|{{businessName}}" });
      });
      expect(messageSend).toHaveBeenCalledWith({ customerId: "cust-1", body: "2026-10-29|||", templateId: "tpl-2" });
    });

    it("uses the built-in fallback body when the tenant has no template", async () => {
      await run({ customerId: "cust-1", visitId: "visit-1" });
      expect(messageSend).toHaveBeenCalledWith({
        customerId: "cust-1",
        body: "Hi Jo, your window clean at 1 High St was completed today. Thank you, Shine Ltd.",
        templateId: null,
      });
    });

    it("skips an opted-out customer", async () => {
      const tp = await run({ customerId: "cust-1", visitId: "visit-1" }, (t) =>
        t.customer.findUnique.mockResolvedValue({ messagesOptOut: true })
      );
      expect(tp.visit.findUnique).not.toHaveBeenCalled();
      expect(messageSend).not.toHaveBeenCalled();
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
    });

    it.each([
      [{ customerId: "cust-1" }, undefined],
      [{ customerId: "cust-1", visitId: "gone" }, (t: Tp) => t.visit.findUnique.mockResolvedValue(null)],
    ])("retries when the visit is missing (%j)", async (p, setup) => {
      const tp = await run(p, setup);
      expect(messageSend).not.toHaveBeenCalled();
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { attempts: 1, lastError: expect.stringContaining("payload visit not found"), status: "pending" },
      });
    });
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
