import { describe, it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: { tenant: { findMany: (...args: unknown[]) => tenantFindMany(...args) } },
}));

const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...args: unknown[]) => getTenantPrismaForSchema(...args),
  withTenantClient: (s: string, fn: (c: unknown) => Promise<unknown>) => Promise.resolve().then(() => fn(getTenantPrismaForSchema(s))),
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
  createMessageService: () => ({ sendBest: (...args: unknown[]) => messageSend(...args) }),
}));

const processInvoiceSendRow = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/invoice-send-batch.service", () => ({
  INVOICE_SEND_EVENT: "invoice.send",
  processInvoiceSendRow: (...args: unknown[]) => processInvoiceSendRow(...args),
}));

const notifyIntegrationDead = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/notify", () => ({ notifyIntegrationDead: (...a: unknown[]) => notifyIntegrationDead(...a) }));

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
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ businessName: "Shine Ltd", ghlConnected: true }) },
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
  it("does nothing when there are no tenants", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runOutboxWorker();
    expect(getTenantPrismaForSchema).not.toHaveBeenCalled();
  });

  it("drains every tenant (email-based sends do not need GHL), not just GHL-connected ones", async () => {
    tenantFindMany.mockResolvedValue([]);
    await runOutboxWorker();
    expect(tenantFindMany).toHaveBeenCalledWith({ select: { schemaName: true } });
  });

  it.each([
    "customer.synced", "visit.completed", "visit.scheduled", "payment.collected", "payment.failed", "debt.overdue",
    "complaint.logged", "complaint.resolved",
  ])("drops %s (not retried, not dead) when GHL is not connected", async (eventType) => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([{ id: "r1", eventType, payload: { customerId: "c1" }, attempts: 0 }]);
    tp.businessSettings.findFirst.mockResolvedValue({ ghlConnected: false });
    getTenantPrismaForSchema.mockReturnValue(tp);
    await runOutboxWorker();
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { status: "dropped", lastError: "GoHighLevel is not connected", processedAt: expect.any(Date) },
    });
    expect(applyGhlTags).not.toHaveBeenCalled();
    expect(syncCustomerToGhl).not.toHaveBeenCalled();
    expect(notifyIntegrationDead).not.toHaveBeenCalled();
  });

  it("a tenant without a settings row counts as GHL-less", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([{ id: "r1", eventType: "customer.synced", payload: { customerId: "c1" }, attempts: 0 }]);
    tp.businessSettings.findFirst.mockResolvedValue(null);
    getTenantPrismaForSchema.mockReturnValue(tp);
    await runOutboxWorker();
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "dropped" }) }));
  });

  it("still sends message.send / message.visit_completed rows when GHL is not connected (email is native)", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([{ id: "r1", eventType: "message.send", payload: { customerId: "c1", body: "hi", channel: "EMAIL" }, attempts: 0 }]);
    tp.businessSettings.findFirst.mockResolvedValue({ ghlConnected: false });
    getTenantPrismaForSchema.mockReturnValue(tp);
    await runOutboxWorker();
    expect(messageSend).toHaveBeenCalled();
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: SENT });
  });

  it("BUG-010: never works on more than TENANT_JOB_CONCURRENCY tenants at once", async () => {
    tenantFindMany.mockResolvedValue(Array.from({ length: 60 }, (_, i) => ({ schemaName: `t_${i}` })));
    let active = 0;
    let peak = 0;
    getTenantPrismaForSchema.mockImplementation(() => {
      const tp = makeTp([]);
      tp.integrationOutbox.findMany.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setImmediate(r));
        active--;
        return [];
      });
      return tp;
    });
    await runOutboxWorker();
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("an unreachable tenant does not stop the others", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }, { schemaName: "t_2" }]);
    const tp2 = makeTp([{ id: "r2", eventType: "customer.synced", payload: { customerId: "c2" }, attempts: 0 }]);
    getTenantPrismaForSchema.mockImplementation((s: string) => {
      if (s === "t_1") throw new Error("boom");
      return tp2;
    });
    await runOutboxWorker();
    expect(syncCustomerToGhl).toHaveBeenCalledWith(tp2, "c2");
  });

  it("hands invoice.send rows to the invoice sender (own claim/result handling) and never touches the row itself", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-9", eventType: "invoice.send", payload: { invoiceId: "i1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(processInvoiceSendRow).toHaveBeenCalledWith(tp, row);
    expect(tp.integrationOutbox.update).not.toHaveBeenCalled();
  });

  it("only drains rows that are due (runAfter unset or passed)", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const tp = makeTp([]);
    getTenantPrismaForSchema.mockReturnValue(tp);
    await runOutboxWorker();
    expect(tp.integrationOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "pending", OR: [{ runAfter: null }, { runAfter: { lte: expect.any(Date) } }] },
      }),
    );
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

  it("BE-12: an unknown eventType is parked as dead (never sent) and the office is told", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "mystery.event", payload: { customerId: "cust-1" }, attempts: 0 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown eventType: mystery.event"));
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { status: "dead", lastError: "Unknown event type: mystery.event", processedAt: expect.any(Date) },
    });
    expect(tp.integrationOutbox.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }));
    expect(notifyIntegrationDead).toHaveBeenCalledWith(tp, { id: "row-1", eventType: "mystery.event", lastError: "Unknown event type: mystery.event" });
    warnSpy.mockRestore();
  });

  it("BE-12: retries (stays pending) with exponential back-off in runAfter when the payload is missing customerId", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const delays: Array<[number, number]> = [[0, 30_000], [1, 120_000], [2, 600_000], [3, 3_600_000], [4, 21_600_000]];
    for (const [attempts, delay] of delays) {
      const row: Row = { id: "row-1", eventType: "visit.completed", payload: {}, attempts };
      const tp = makeTp([row]);
      getTenantPrismaForSchema.mockReturnValue(tp);
      const before = Date.now();

      await runOutboxWorker();

      const data = (tp.integrationOutbox.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
      expect(data).toMatchObject({ attempts: attempts + 1, lastError: expect.stringContaining("payload missing customerId"), status: "pending" });
      expect(data.runAfter.getTime() - before).toBeGreaterThanOrEqual(delay);
      expect(data.runAfter.getTime() - before).toBeLessThan(delay + 5000);
    }
    expect(notifyIntegrationDead).not.toHaveBeenCalled();
  });

  it("marks the row dead after the maximum attempts, logs it and notifies the office", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
    const row: Row = { id: "row-1", eventType: "visit.completed", payload: {}, attempts: 5 };
    const tp = makeTp([row]);
    getTenantPrismaForSchema.mockReturnValue(tp);

    await runOutboxWorker();

    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: {
        attempts: 6,
        lastError: expect.stringContaining("payload missing customerId"),
        status: "dead",
        runAfter: null,
        processedAt: expect.any(Date),
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("row row-1 (visit.completed) dead after 6 attempts:"),
      expect.any(Error)
    );
    expect(notifyIntegrationDead).toHaveBeenCalledWith(tp, { id: "row-1", eventType: "visit.completed", lastError: expect.stringContaining("payload missing customerId") });
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
      expect(messageSend).toHaveBeenCalledWith({ customerId: "cust-1", preferred: "SMS", body: "Hi Jo", templateId: "tpl-1" });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
    });

    it("sends without a visit check or template when the payload has neither", async () => {
      const tp = await run({ customerId: "cust-1", body: "Hi" });
      expect(tp.visit.findUnique).not.toHaveBeenCalled();
      expect(messageSend).toHaveBeenCalledWith({ customerId: "cust-1", preferred: undefined, body: "Hi", templateId: null });
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

    it("records a skip (no channel / opted out at send time) as skipped with the reason, not as failed", async () => {
      messageSend.mockResolvedValueOnce({ status: "skipped", reason: "NO_AVAILABLE_CHANNEL" });
      const tp = await run(payload);
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { status: "skipped", lastError: "NO_AVAILABLE_CHANNEL", processedAt: expect.any(Date) },
      });
    });

    it("retries when the body is missing or the send fails", async () => {
      let tp = await run({ customerId: "cust-1" });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { attempts: 1, lastError: expect.stringContaining("payload missing body"), status: "pending", runAfter: expect.any(Date) },
      });
      messageSend.mockRejectedValueOnce(new Error("GHL down"));
      tp = await run(payload);
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { attempts: 1, lastError: expect.stringContaining("GHL down"), status: "pending", runAfter: expect.any(Date) },
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

    it("a skipped visit-completed message is recorded as skipped with the reason", async () => {
      messageSend.mockResolvedValueOnce({ status: "skipped", reason: "NO_AVAILABLE_CHANNEL" });
      const tp = await run({ customerId: "cust-1", visitId: "visit-1" });
      expect(tp.integrationOutbox.update).toHaveBeenCalledWith({
        where: { id: "row-1" },
        data: { status: "skipped", lastError: "NO_AVAILABLE_CHANNEL", processedAt: expect.any(Date) },
      });
    });

    it("renders the tenant template and sends it", async () => {
      const tp = await run({ customerId: "cust-1", visitId: "visit-1", template: "Visit completed" }, (t) =>
        t.messageTemplate.findFirst.mockResolvedValue({
          id: "tpl-9",
          body: "Hi [Customer Name] ({{firstName}}), {{address}} done {{date}} by {{technicianName}} on {{roundName}} - {{businessName}}",
        })
      );
      expect(tp.messageTemplate.findFirst).toHaveBeenCalledWith({
        where: { name: { equals: "Visit completed", mode: "insensitive" } },
        select: { id: true, body: true, subject: true },
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
        data: { attempts: 1, lastError: expect.stringContaining("payload visit not found"), status: "pending", runAfter: expect.any(Date) },
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
