import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../../generated/tenant-client";

// One stop = every visit for the same property, day and technician (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.3).

const decrypt = vi.fn((..._a: unknown[]) => "token");
vi.mock("../../lib/crypto", () => ({ decrypt: (...a: unknown[]) => decrypt(...a) }));
const getGcClient = vi.fn((..._a: unknown[]) => ({ fake: "gc" }));
vi.mock("../../integrations/gocardless/client", () => ({ getGcClient: (...a: unknown[]) => getGcClient(...a) }));
const createGcPayment = vi.fn();
vi.mock("../../integrations/gocardless/payment", () => ({ createGcPayment: (...a: unknown[]) => createGcPayment(...a) }));
const autoCreateForCompletedVisit = vi.fn();
vi.mock("../invoice.service", () => ({
  createInvoiceService: () => ({ autoCreateForCompletedVisit: (...a: unknown[]) => autoCreateForCompletedVisit(...a) }),
}));
const notifyAdmins = vi.fn();
vi.mock("../notify", () => ({ notifyAdmins: (...a: unknown[]) => notifyAdmins(...a) }));

import { createVisitCompletionService, parseStopServices, VISIT_COMPLETED_MESSAGE_EVENT } from "../visit-completion";
import { DD_SETUP_LINK_EVENT } from "../direct-debit.service";

const DAY = new Date("2026-11-19T00:00:00.000Z");
const customer = (over: Record<string, unknown> = {}) => ({
  id: "cust-1",
  name: "Tom Jones",
  paymentMethod: null,
  gocardlessMandateId: null,
  gocardlessMandateStatus: null,
  messagesOptOut: false,
  ...over,
});

function visit(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: VisitStatus.IN_PROGRESS,
    price: new Prisma.Decimal(20),
    paymentMethod: null,
    propertyId: "prop-1",
    technicianId: "tech-1",
    roundId: null,
    date: DAY,
    createdAt: new Date(`2026-11-01T00:00:0${id.slice(-1)}.000Z`),
    servicePlanId: `plan-${id}`,
    servicePlan: { id: `plan-${id}`, cleaningFrequency: "FOUR_WEEKLY", nextDueDate: new Date("2026-12-17T00:00:00.000Z"), paymentMethod: null },
    service: { name: `Service ${id}` },
    payment: null,
    billedWithVisitId: null,
    property: { addressLine: "1 High St", customer: customer() },
    ...over,
  };
}

function makeTp(stop: ReturnType<typeof visit>[], settings: Record<string, unknown> | null = null) {
  const byId = new Map(stop.map((v) => [v.id, v]));
  const tp = {
    visit: {
      findUnique: vi.fn(async (args: any) => byId.get(args.where.id) ?? null),
      findMany: vi.fn(async () => stop),
      update: vi.fn((args: any) => ({ op: "visit.update", args })),
    },
    payment: { create: vi.fn((args: any) => ({ op: "payment.create", args })) },
    activityLog: { create: vi.fn((args: any) => ({ op: "activityLog.create", args })) },
    propertyNote: { create: vi.fn((args: any) => ({ op: "propertyNote.create", args })) },
    integrationOutbox: { create: vi.fn((args: any) => ({ op: "outbox.create", args })) },
    customer: { update: vi.fn((args: any) => ({ op: "customer.update", args })) },
    businessSettings: { findFirst: vi.fn(async () => settings) },
    servicePlan: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn((args: any) => ({ op: "servicePlan.update", args })) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (ops: any[]) =>
      ops.map((o) => {
        if (o.op === "visit.update") return { id: o.args.where.id, status: o.args.data.status };
        if (o.op === "payment.create") return { id: "pay-1", ...o.args.data };
        return {};
      }),
    ),
  };
  return tp;
}

const txOps = (tp: ReturnType<typeof makeTp>) => tp.$transaction.mock.calls[0][0] as Array<{ op: string; args: any }>;
const updates = (tp: ReturnType<typeof makeTp>) => txOps(tp).filter((o) => o.op === "visit.update").map((o) => o.args);
const outbox = (tp: ReturnType<typeof makeTp>) => txOps(tp).filter((o) => o.op === "outbox.create").map((o) => o.args.data);
const payments = (tp: ReturnType<typeof makeTp>) => txOps(tp).filter((o) => o.op === "payment.create").map((o) => o.args.data);

const complete = (tp: ReturnType<typeof makeTp>, id: string, opts: Record<string, unknown>) =>
  createVisitCompletionService(tp as any).completeVisit(id, opts as any);

beforeEach(() => {
  vi.clearAllMocks();
  autoCreateForCompletedVisit.mockResolvedValue({ invoiceId: "inv-1", status: "DRAFT" });
});

describe("parseStopServices", () => {
  it("returns undefined when services is not sent", () => {
    expect(parseStopServices({})).toBeUndefined();
    expect(parseStopServices({ services: null })).toBeUndefined();
  });

  it("parses done and skipped services, trimming the reason", () => {
    expect(
      parseStopServices({
        services: [
          { visitId: "v1", done: true },
          { visitId: "v2", done: false, skipReason: "  Gutters blocked " },
        ],
      }),
    ).toEqual([
      { visitId: "v1", done: true },
      { visitId: "v2", done: false, skipReason: "Gutters blocked" },
    ]);
  });

  it("drops a skip reason sent with a done service", () => {
    expect(parseStopServices({ services: [{ visitId: "v1", done: true, skipReason: "x" }] })).toEqual([{ visitId: "v1", done: true }]);
  });

  it.each([
    ["not an array", { services: "v1" }],
    ["empty", { services: [] }],
    ["too many", { services: Array.from({ length: 21 }, (_, i) => ({ visitId: `v${i}`, done: true })) }],
    ["not an object", { services: ["v1"] }],
    ["no visitId", { services: [{ done: true }] }],
    ["blank visitId", { services: [{ visitId: " ", done: true }] }],
    ["done not boolean", { services: [{ visitId: "v1", done: "yes" }] }],
    ["duplicate visitId", { services: [{ visitId: "v1", done: true }, { visitId: "v1", done: false, skipReason: "x" }] }],
    ["skip without reason", { services: [{ visitId: "v1", done: false }] }],
    ["blank skip reason", { services: [{ visitId: "v1", done: false, skipReason: "   " }] }],
    ["skip reason too long", { services: [{ visitId: "v1", done: false, skipReason: "x".repeat(201) }] }],
    ["skip reason not a string", { services: [{ visitId: "v1", done: false, skipReason: 5 }] }],
  ])("rejects %s", (_name, body) => {
    expect(() => parseStopServices(body as Record<string, unknown>)).toThrow(expect.objectContaining({ statusCode: 400, code: "INVALID_SERVICES" }));
  });
});

describe("completeVisit with services (one stop)", () => {
  it("completes every done service, one payment for the total on the first done visit", async () => {
    const tp = makeTp([visit("v1"), visit("v2", { price: new Prisma.Decimal(15) }), visit("v3")]);
    const result = await complete(tp, "v2", {
      payment: { method: "CASH" },
      services: [
        { visitId: "v1", done: true },
        { visitId: "v2", done: true },
        { visitId: "v3", done: true },
      ],
    });

    expect(tp.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ propertyId: "prop-1", technicianId: "tech-1", status: { not: VisitStatus.CANCELLED } }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    expect(updates(tp)).toEqual([
      { where: { id: "v1" }, data: expect.objectContaining({ status: VisitStatus.COMPLETED, collectedVia: PaymentMethod.CASH }) },
      { where: { id: "v2" }, data: expect.objectContaining({ status: VisitStatus.COMPLETED, billedWithVisitId: "v1" }) },
      { where: { id: "v3" }, data: expect.objectContaining({ status: VisitStatus.COMPLETED, billedWithVisitId: "v1" }) },
    ]);
    expect(updates(tp)[0].data).not.toHaveProperty("billedWithVisitId");
    expect(payments(tp)).toEqual([
      expect.objectContaining({ visitId: "v1", amount: 55, method: PaymentMethod.CASH, status: PaymentStatus.PAID }),
    ]);
    expect(result).toMatchObject({
      id: "v1",
      status: VisitStatus.COMPLETED,
      payment: { id: "pay-1", method: PaymentMethod.CASH, status: PaymentStatus.PAID, amount: 55 },
      invoice: { id: "inv-1", status: "DRAFT" },
      services: [
        { visitId: "v1", status: VisitStatus.COMPLETED },
        { visitId: "v2", status: VisitStatus.COMPLETED },
        { visitId: "v3", status: VisitStatus.COMPLETED },
      ],
      ignored: [],
    });
    expect(autoCreateForCompletedVisit).toHaveBeenCalledTimes(1);
    expect(autoCreateForCompletedVisit).toHaveBeenCalledWith("v1");
  });

  it("queues one visit.completed per done service but ONE customer message naming them all", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [
        { visitId: "v1", done: true },
        { visitId: "v2", done: true },
      ],
    });
    const events = outbox(tp);
    expect(events.filter((e) => e.eventType === "visit.completed").map((e) => e.payload.visitId)).toEqual(["v1", "v2"]);
    const messages = events.filter((e) => e.eventType === VISIT_COMPLETED_MESSAGE_EVENT);
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual(expect.objectContaining({ customerId: "cust-1", visitId: "v1", visitIds: ["v1", "v2"] }));
  });

  it("sends no message when the customer opted out", async () => {
    const tp = makeTp([visit("v1", { property: { addressLine: "1 High St", customer: customer({ messagesOptOut: true }) } }), visit("v2")]);
    await complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(outbox(tp).filter((e) => e.eventType === VISIT_COMPLETED_MESSAGE_EVENT)).toEqual([]);
  });

  it("charges VAT per service and takes the total", async () => {
    const tp = makeTp([visit("v1", { price: new Prisma.Decimal(10.05) }), visit("v2", { price: new Prisma.Decimal(10.05) })], {
      vatInInvoices: true,
      vatRate: 20,
    });
    const result = await complete(tp, "v1", {
      payment: { method: "BACS" },
      services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }],
    });
    // 10.05 + 2.01 = 12.06 per service
    expect(payments(tp)[0]).toEqual(expect.objectContaining({ amount: 24.12, method: PaymentMethod.BACS, status: PaymentStatus.PENDING }));
    expect(result.payment?.amount).toBe(24.12);
  });

  it("skips the unticked services with their reason and tells the office once", async () => {
    const tp = makeTp([visit("v1"), visit("v2", { service: { name: "Gutter clear" } }), visit("v3", { service: { name: "Fascia" } })]);
    const result = await complete(tp, "v1", {
      payment: { method: "CASH", amount: 20 },
      services: [
        { visitId: "v1", done: true },
        { visitId: "v2", done: false, skipReason: "Gutters blocked" },
        { visitId: "v3", done: false, skipReason: "No ladder access" },
      ],
    });
    expect(updates(tp)).toEqual([
      { where: { id: "v1" }, data: expect.objectContaining({ status: VisitStatus.COMPLETED }) },
      { where: { id: "v2" }, data: { status: VisitStatus.SKIPPED, skipReason: "Gutters blocked" } },
      { where: { id: "v3" }, data: { status: VisitStatus.SKIPPED, skipReason: "No ladder access" } },
    ]);
    // A skipped service waits for its next cycle: its plan is not touched.
    expect(tp.servicePlan.update.mock.calls.map((c) => c[0].where.id)).toEqual(["plan-v1"]);
    expect(payments(tp)[0]).toEqual(expect.objectContaining({ visitId: "v1", amount: 20 }));
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      tp,
      expect.objectContaining({
        type: "SCHEDULE",
        title: "Services skipped",
        body: expect.stringContaining("Gutter clear: Gutters blocked"),
        data: expect.objectContaining({ visitId: "v1", propertyId: "prop-1", date: "2026-11-19" }),
      }),
    );
    expect(notifyAdmins.mock.calls[0][1].body).toContain("Fascia: No ladder access");
    expect(result.services).toEqual([
      { visitId: "v1", status: VisitStatus.COMPLETED },
      { visitId: "v2", status: VisitStatus.SKIPPED },
      { visitId: "v3", status: VisitStatus.SKIPPED },
    ]);
  });

  it("anchors the payment on the first DONE visit when the first visit is skipped", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    const result = await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [
        { visitId: "v1", done: false, skipReason: "Locked gate" },
        { visitId: "v2", done: true },
      ],
    });
    expect(payments(tp)[0].visitId).toBe("v2");
    expect(updates(tp).find((u) => u.where.id === "v2")!.data).not.toHaveProperty("billedWithVisitId");
    expect(result.id).toBe("v2");
    expect(autoCreateForCompletedVisit).toHaveBeenCalledWith("v2");
  });

  it("every service skipped: a stop skip with no payment, invoice or message", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    const result = await complete(tp, "v2", {
      payment: { method: "CASH" },
      services: [
        { visitId: "v1", done: false, skipReason: "Nobody home" },
        { visitId: "v2", done: false, skipReason: "Nobody home" },
      ],
    });
    expect(updates(tp).map((u) => u.data.status)).toEqual([VisitStatus.SKIPPED, VisitStatus.SKIPPED]);
    expect(payments(tp)).toEqual([]);
    expect(outbox(tp)).toEqual([]);
    expect(autoCreateForCompletedVisit).not.toHaveBeenCalled();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: "v2", status: VisitStatus.SKIPPED, payment: null, invoice: null });
  });

  it("ignores listed services that are no longer open, and leaves unlisted open ones alone", async () => {
    const tp = makeTp([
      visit("v1"),
      visit("v2", { status: VisitStatus.COMPLETED }),
      visit("v3", { status: VisitStatus.SKIPPED }),
      visit("v4", { status: VisitStatus.SCHEDULED }),
    ]);
    const result = await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [
        { visitId: "v1", done: true },
        { visitId: "v2", done: true },
        { visitId: "v3", done: true },
      ],
    });
    expect(updates(tp).map((u) => u.where.id)).toEqual(["v1"]);
    expect(payments(tp)[0].amount).toBe(20);
    expect(result.ignored).toEqual(["v2", "v3"]);
    expect(result.services).toEqual([
      { visitId: "v1", status: VisitStatus.COMPLETED },
      { visitId: "v2", status: VisitStatus.COMPLETED },
      { visitId: "v3", status: VisitStatus.SKIPPED },
      { visitId: "v4", status: VisitStatus.SCHEDULED },
    ]);
  });

  it("does nothing when every listed service is already closed (offline replay after the office acted)", async () => {
    const tp = makeTp([visit("v1", { status: VisitStatus.COMPLETED }), visit("v2", { status: VisitStatus.CANCELLED })]);
    // a cancelled visit is never in the stop query result, but a stale app can still list it
    tp.visit.findMany.mockResolvedValue([visit("v1", { status: VisitStatus.COMPLETED })]);
    const result = await complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }] });
    expect(tp.$transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "v1", status: VisitStatus.COMPLETED, payment: null, invoice: null, ignored: ["v1"] });
  });

  it("a listed service the office moved to another day (same property) is ignored, not an error", async () => {
    const tp = makeTp([visit("v1")]);
    const load = tp.visit.findUnique.getMockImplementation()!;
    tp.visit.findUnique.mockImplementation(async (args: any) => (args.where.id === "moved" ? { propertyId: "prop-1" } : load(args)));
    const result = await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [{ visitId: "v1", done: true }, { visitId: "moved", done: true }],
    });
    expect(result.ignored).toEqual(["moved"]);
    expect(updates(tp).map((u) => u.where.id)).toEqual(["v1"]);
  });

  it("names the services skipped, with the round, for the office; a nameless service reads Window clean", async () => {
    const tp = makeTp([visit("v1", { roundId: "r1" }), visit("v2", { roundId: "r1", service: null })]);
    await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [{ visitId: "v1", done: true }, { visitId: "v2", done: false, skipReason: "Blocked" }],
    });
    expect(notifyAdmins.mock.calls[0][1]).toMatchObject({ body: "Window clean: Blocked", data: { roundId: "r1" } });
  });

  it("an office notification failure is logged and never undoes the completion", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    notifyAdmins.mockRejectedValueOnce(new Error("push down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await complete(tp, "v1", {
      payment: { method: "CASH" },
      services: [{ visitId: "v1", done: true }, { visitId: "v2", done: false, skipReason: "Blocked" }],
    });
    expect(result.status).toBe(VisitStatus.COMPLETED);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no method sent: the customer's usual one applies; a one-off with no plan and a held invoice still complete", async () => {
    const bacs = customer({ paymentMethod: PaymentMethod.BACS });
    const tp = makeTp([visit("v1", { servicePlanId: null, servicePlan: null, property: { addressLine: "1 High St", customer: bacs } })]);
    autoCreateForCompletedVisit.mockResolvedValue(null); // e.g. customer on payment hold
    const result = await complete(tp, "v1", { services: [{ visitId: "v1", done: true }] });
    expect(updates(tp)[0].data).not.toHaveProperty("collectedVia");
    expect(payments(tp)).toEqual([expect.objectContaining({ method: PaymentMethod.BACS, status: PaymentStatus.PENDING, amount: 20 })]);
    expect(tp.servicePlan.update).not.toHaveBeenCalled();
    expect(result.invoice).toBeNull();
  });

  it("Direct Debit with a mandate but no GoCardless token records no payment", async () => {
    const gc = customer({ paymentMethod: PaymentMethod.GOCARDLESS, gocardlessMandateId: "MD1", gocardlessMandateStatus: "active" });
    const tp = makeTp([visit("v1", { property: { addressLine: "1 High St", customer: gc } })], { gocardlessConnected: true });
    await complete(tp, "v1", { payment: { method: "GOCARDLESS" }, services: [{ visitId: "v1", done: true }] });
    expect(createGcPayment).not.toHaveBeenCalled();
    expect(payments(tp)).toEqual([]);
  });

  it("one service by Direct Debit is described in the singular", async () => {
    const gc = customer({ paymentMethod: PaymentMethod.GOCARDLESS, gocardlessMandateId: "MD1", gocardlessMandateStatus: "active" });
    const tp = makeTp([visit("v1", { property: { addressLine: "1 High St", customer: gc } })], {
      gocardlessConnected: true,
      gocardlessAccessTokenEncrypted: "enc",
    });
    createGcPayment.mockResolvedValue({ id: "PM2" });
    await complete(tp, "v1", { payment: { method: "GOCARDLESS" }, services: [{ visitId: "v1", done: true }] });
    expect(createGcPayment.mock.calls[0][1].description).toBe("Window cleaning — 1 service on 2026-11-19");
  });

  it("a database error that is not a lost race is passed on", async () => {
    const tp = makeTp([visit("v1")]);
    tp.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }] })).rejects.toThrow("db down");
  });

  it("a lost race whose winner has not completed the visit is passed on too", async () => {
    const tp = makeTp([visit("v1")]);
    tp.$transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    tp.visit.findUnique.mockResolvedValueOnce(visit("v1")).mockResolvedValueOnce({ id: "v1", status: VisitStatus.IN_PROGRESS } as any);
    await expect(complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }] })).rejects.toThrow("dup");
  });

  it("rejects a service from another stop", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await expect(
      complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "other", done: true }] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "NOT_IN_STOP" });
    expect(tp.$transaction).not.toHaveBeenCalled();
  });

  it("404s an unknown visit", async () => {
    const tp = makeTp([visit("v1")]);
    await expect(complete(tp, "nope", { services: [{ visitId: "nope", done: true }] })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("cheque: one PENDING payment for the total with the cheque number", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await complete(tp, "v1", {
      payment: { method: "CHEQUE", chequeNumber: "000123" },
      services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }],
    });
    expect(payments(tp)).toEqual([
      expect.objectContaining({ visitId: "v1", amount: 40, method: PaymentMethod.CHEQUE, status: PaymentStatus.PENDING, reference: "000123" }),
    ]);
    expect(txOps(tp).filter((o) => o.op === "activityLog.create" && o.args.data.type === "CHEQUE_RECEIVED")).toHaveLength(1);
  });

  it("cash with an effective cash method and no confirmation is refused before any write", async () => {
    const tp = makeTp([visit("v1", { property: { addressLine: "1 High St", customer: customer({ paymentMethod: PaymentMethod.CASH }) } })]);
    await expect(complete(tp, "v1", { services: [{ visitId: "v1", done: true }] })).rejects.toMatchObject({
      code: "PAYMENT_CONFIRMATION_REQUIRED",
    });
    expect(tp.$transaction).not.toHaveBeenCalled();
  });

  it("Direct Debit with a mandate: ONE GoCardless collection for the total", async () => {
    const gcCustomer = customer({ paymentMethod: PaymentMethod.GOCARDLESS, gocardlessMandateId: "MD1", gocardlessMandateStatus: "active" });
    const tp = makeTp(
      [visit("v1", { property: { addressLine: "1 High St", customer: gcCustomer } }), visit("v2", { property: { addressLine: "1 High St", customer: gcCustomer } })],
      { gocardlessConnected: true, gocardlessAccessTokenEncrypted: "enc", gocardlessEnvironment: "sandbox" },
    );
    createGcPayment.mockResolvedValue({ id: "PM1" });
    await complete(tp, "v1", { payment: { method: "GOCARDLESS" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(createGcPayment).toHaveBeenCalledTimes(1);
    expect(createGcPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mandateId: "MD1", amountPence: 4000, metadata: expect.objectContaining({ visitId: "v1", customerId: "cust-1" }) }),
    );
    expect(payments(tp)).toEqual([expect.objectContaining({ visitId: "v1", gocardlessId: "PM1", amount: 40, status: PaymentStatus.PENDING })]);
  });

  it("Direct Debit without a mandate: ONE setup link", async () => {
    const tp = makeTp([visit("v1"), visit("v2")], { gocardlessConnected: true });
    const result = await complete(tp, "v1", { payment: { method: "GOCARDLESS" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(outbox(tp).filter((e) => e.eventType === DD_SETUP_LINK_EVENT)).toHaveLength(1);
    expect(payments(tp)).toEqual([]);
    expect(result.directDebitSetupLinkQueued).toBe(true);
  });

  it("card (Stripe) records the choice on every done service and creates no payment", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await complete(tp, "v1", { payment: { method: "STRIPE" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(payments(tp)).toEqual([]);
    expect(updates(tp).map((u) => u.data.collectedVia)).toEqual([PaymentMethod.STRIPE, PaymentMethod.STRIPE]);
  });

  it("records the payment method once and updates the customer default once", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await complete(tp, "v1", {
      payment: { method: "BACS", updateCustomerDefault: true },
      services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }],
    });
    expect(txOps(tp).filter((o) => o.op === "activityLog.create" && o.args.data.type === "PAYMENT_METHOD_RECORDED")).toHaveLength(1);
    expect(txOps(tp).filter((o) => o.op === "customer.update")).toHaveLength(1);
  });

  it("writes the technician's note once", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    await complete(tp, "v1", { payment: { method: "CASH" }, note: "Dog in garden", services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(txOps(tp).filter((o) => o.op === "propertyNote.create")).toHaveLength(1);
  });

  it("creates no second payment when a done service already has one", async () => {
    const tp = makeTp([visit("v1", { payment: { id: "old" } }), visit("v2")]);
    await complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(payments(tp)).toEqual([]);
  });

  it("a race on Payment.visitId returns the winner's result", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    tp.$transaction.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    tp.visit.findUnique
      .mockResolvedValueOnce(visit("v1"))
      .mockResolvedValueOnce({ id: "v1", status: VisitStatus.COMPLETED } as any);
    const result = await complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(result).toMatchObject({ id: "v1", status: VisitStatus.COMPLETED, payment: null, invoice: null });
  });

  it("an invoice failure never undoes the completion", async () => {
    const tp = makeTp([visit("v1"), visit("v2")]);
    autoCreateForCompletedVisit.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await complete(tp, "v1", { payment: { method: "CASH" }, services: [{ visitId: "v1", done: true }, { visitId: "v2", done: true }] });
    expect(result.invoice).toBeNull();
    expect(result.status).toBe(VisitStatus.COMPLETED);
    spy.mockRestore();
  });
});
