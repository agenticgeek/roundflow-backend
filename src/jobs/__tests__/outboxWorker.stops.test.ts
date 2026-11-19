import { beforeEach, describe, expect, it, vi } from "vitest";

// Stop-level customer messages (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.6).

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...a),
  withTenantClient: (s: string, fn: (c: unknown) => Promise<unknown>) => Promise.resolve().then(() => fn(getTenantPrismaForSchema(s))),
}));
vi.mock("../../integrations/ghl/sync", () => ({ syncCustomerToGhl: vi.fn(), applyGhlTags: vi.fn(), applyGhlCustomFields: vi.fn() }));
vi.mock("../../services/payment.service", () => ({ computeBalanceOwed: vi.fn() }));
const messageSend = vi.fn();
vi.mock("../../services/message.service", () => ({ createMessageService: () => ({ sendBest: (...a: unknown[]) => messageSend(...a) }) }));
vi.mock("../../services/invoice-send-batch.service", () => ({ INVOICE_SEND_EVENT: "invoice.send", processInvoiceSendRow: vi.fn() }));
vi.mock("../../services/notify", () => ({ notifyIntegrationDead: vi.fn() }));
vi.mock("../../services/direct-debit.service", () => ({ DD_SETUP_LINK_EVENT: "dd.setup_link", createDirectDebitService: () => ({ sendLink: vi.fn() }) }));

import { runOutboxWorker } from "../outboxWorker";
import { FALLBACK_BODIES, serviceList } from "../../services/message-templates";

function makeTp(eventType: string, payload: Record<string, unknown>) {
  return {
    integrationOutbox: {
      findMany: vi.fn().mockResolvedValue([{ id: "row-1", eventType, payload, attempts: 0 }]),
      update: vi.fn().mockResolvedValue({}),
    },
    visit: { findUnique: vi.fn(), findMany: vi.fn() },
    customer: { findUnique: vi.fn().mockResolvedValue({ messagesOptOut: false }) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ businessName: "Shine Ltd", ghlConnected: true }) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}
const SENT = { status: "sent", processedAt: expect.any(Date) };

async function run(tp: ReturnType<typeof makeTp>) {
  tenantFindMany.mockResolvedValue([{ schemaName: "t_1" }]);
  getTenantPrismaForSchema.mockReturnValue(tp);
  await runOutboxWorker();
}

beforeEach(() => {
  vi.clearAllMocks();
  messageSend.mockResolvedValue({ status: "sent", messageId: "m1", channel: "SMS" });
});

describe("serviceList", () => {
  it.each([
    [[], "window clean"],
    [["Window clean"], "window clean"],
    [["Window clean", "Gutter clear"], "window clean and gutter clear"],
    [["Window clean", "Gutter clear", "Fascia"], "window clean, gutter clear and fascia"],
    [["Window clean", null, "Window clean"], "window clean"],
  ])("%j -> %s", (names, expected) => {
    expect(serviceList(names as Array<string | null>)).toBe(expected);
  });
});

describe("message.visit_completed for a stop", () => {
  const visit = {
    completedAt: new Date("2026-11-19T10:00:00Z"),
    date: new Date("2026-11-19T00:00:00Z"),
    property: { addressLine: "1 High St", customer: { name: "Jo Bloggs" } },
    round: { name: "Monday" },
    technician: { name: "Alex" },
  };

  it("names every service done in the built-in message", async () => {
    expect(FALLBACK_BODIES.VISIT_COMPLETED).toContain("{{services}}");
    const tp = makeTp("message.visit_completed", { customerId: "c1", visitId: "v1", visitIds: ["v1", "v2"] });
    tp.visit.findUnique.mockResolvedValue(visit);
    tp.visit.findMany.mockResolvedValue([{ service: { name: "Window clean" } }, { service: { name: "Gutter clear" } }]);
    await run(tp);
    expect(tp.visit.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] } },
      select: { service: { select: { name: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(messageSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hi Jo, your window clean and gutter clear at 1 High St was completed today. Thank you, Shine Ltd." }),
    );
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
  });

  it("an older row without visitIds names the visit's own service", async () => {
    const tp = makeTp("message.visit_completed", { customerId: "c1", visitId: "v1" });
    tp.visit.findUnique.mockResolvedValue(visit);
    tp.visit.findMany.mockResolvedValue([{ service: { name: "Conservatory roof" } }]);
    await run(tp);
    expect(tp.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["v1"] } } }));
    expect(messageSend.mock.calls[0][0].body).toContain("your conservatory roof at 1 High St");
  });
});

describe("message.send (reminder) for a stop", () => {
  const payload = { customerId: "c1", visitId: "v1", visitIds: ["v1", "v2"], channel: "SMS", body: "Hi", reason: "PRE_CLEAN_REMINDER" };

  it("still sends while any service in the stop is SCHEDULED", async () => {
    const tp = makeTp("message.send", payload);
    tp.visit.findMany.mockResolvedValue([{ status: "CANCELLED" }, { status: "SCHEDULED" }]);
    await run(tp);
    expect(tp.visit.findMany).toHaveBeenCalledWith({ where: { id: { in: ["v1", "v2"] } }, select: { status: true } });
    expect(tp.visit.findUnique).not.toHaveBeenCalled();
    expect(messageSend).toHaveBeenCalledTimes(1);
  });

  it("is dropped when no service in the stop is SCHEDULED any more", async () => {
    const tp = makeTp("message.send", payload);
    tp.visit.findMany.mockResolvedValue([{ status: "CANCELLED" }, { status: "SKIPPED" }]);
    await run(tp);
    expect(messageSend).not.toHaveBeenCalled();
    expect(tp.integrationOutbox.update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: SENT });
  });
});
