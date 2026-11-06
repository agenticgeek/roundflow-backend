import { describe, it, expect, vi, beforeEach } from "vitest";

const channelCaps = vi.fn();
vi.mock("../message.service", async (orig) => ({
  ...(await orig<typeof import("../message.service")>()),
  createMessageService: vi.fn(() => ({ channelCaps })),
}));
const notifyIntegrationDead = vi.fn().mockResolvedValue(undefined);
vi.mock("../notify", () => ({ notifyIntegrationDead: (...a: unknown[]) => notifyIntegrationDead(...a) }));
const sendInvoice = vi.fn();
vi.mock("../invoice.service", async (orig) => ({
  ...(await orig<typeof import("../invoice.service")>()),
  createInvoiceService: vi.fn(() => ({ sendInvoice })),
}));

import {
  createInvoiceSendBatchService,
  processInvoiceSendRow,
  resolveInvoiceChannel,
  dedupeKeyFor,
  CLAIM_LEASE_MS,
  MAX_BATCH,
} from "../invoice-send-batch.service";
import { AppError } from "../../lib/app-error";
import { Prisma } from "../../generated/tenant-client";

const BOTH = { ghl: true, email: { available: true } } as const;
const EMAIL_ONLY = { ghl: false, email: { available: true } } as const;
const GHL_ONLY = { ghl: true, email: { available: false, reason: "EMAIL_PAUSED" } } as const;
const NEITHER = { ghl: false, email: { available: false, reason: "EMAIL_NOT_CONFIGURED" } } as const;
const customer = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Jo", phone: "07", email: "j@x.test", messagesOptOut: false, ...over });
const inv = (id: string, over: Record<string, unknown> = {}) => ({
  id, invoiceNumber: `INV-${id}`, customerId: "c1", status: "DRAFT", customer: customer(), ...over,
});

function makePrisma(invoices: unknown[] = [], total = invoices.length) {
  const prisma = {
    invoice: { findMany: vi.fn().mockResolvedValue(invoices), count: vi.fn().mockResolvedValue(total), findUnique: vi.fn() },
    customer: { findUnique: vi.fn() },
    integrationOutbox: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { prisma, tp: prisma as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  channelCaps.mockResolvedValue(BOTH);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveInvoiceChannel / dedupeKeyFor", () => {
  it("defaults to EMAIL when the customer has an email, SMS (GHL) otherwise; reports opt-out / no contact / no channel", () => {
    expect(resolveInvoiceChannel(customer(), undefined, BOTH)).toEqual({ channel: "EMAIL" });
    expect(resolveInvoiceChannel(customer(), undefined, EMAIL_ONLY)).toEqual({ channel: "EMAIL" });
    expect(resolveInvoiceChannel(customer({ email: null }), undefined, BOTH)).toEqual({ channel: "SMS" });
    expect(resolveInvoiceChannel(customer(), undefined, GHL_ONLY)).toEqual({ channel: "SMS" });
    expect(resolveInvoiceChannel(customer({ messagesOptOut: true }), undefined, BOTH)).toEqual({ skip: "CUSTOMER_OPTED_OUT" });
    expect(resolveInvoiceChannel(customer({ phone: null, email: null }), undefined, BOTH)).toEqual({ skip: "NO_CONTACT_FOR_CHANNEL" });
    expect(resolveInvoiceChannel(customer({ email: null }), undefined, EMAIL_ONLY)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
    expect(resolveInvoiceChannel(customer(), undefined, NEITHER)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
  });
  it("an explicit channel is honoured when usable, else skipped with the right reason", () => {
    expect(resolveInvoiceChannel(customer(), "SMS" as never, BOTH)).toEqual({ channel: "SMS" });
    expect(resolveInvoiceChannel(customer(), "SMS" as never, EMAIL_ONLY)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
    expect(resolveInvoiceChannel(customer({ email: null }), "EMAIL" as never, BOTH)).toEqual({ skip: "NO_CONTACT_FOR_CHANNEL" });
    expect(resolveInvoiceChannel(customer(), "EMAIL" as never, GHL_ONLY)).toEqual({ skip: "NO_AVAILABLE_CHANNEL" });
  });
  it("one key per draft invoice, an hourly key for resends", () => {
    const t = new Date("2026-11-06T10:15:00Z");
    expect(dedupeKeyFor("i1", "DRAFT" as never, t)).toBe("invoice.send:i1");
    expect(dedupeKeyFor("i1", "SENT" as never, t)).toBe(dedupeKeyFor("i1", "SENT" as never, new Date("2026-11-06T10:59:00Z")));
    expect(dedupeKeyFor("i1", "SENT" as never, t)).not.toBe(dedupeKeyFor("i1", "SENT" as never, new Date("2026-11-06T11:00:00Z")));
    expect(dedupeKeyFor("i1", "DRAFT" as never)).toBe("invoice.send:i1");
  });
});

describe("preview", () => {
  it("defaults to DRAFT invoices, counts by channel and by skip reason", async () => {
    const { prisma, tp } = makePrisma([
      inv("a"),
      inv("b", { customer: customer({ email: null }) }),
      inv("c", { customer: customer({ messagesOptOut: true }) }),
      inv("d", { customer: customer({ phone: null, email: null }) }),
      inv("e", { status: "SENT" }),
      inv("f", { status: "PAID" }),
      inv("g", { status: "VOID" }),
    ]);
    const p = await createInvoiceSendBatchService(tp).preview({});
    expect(prisma.invoice.count.mock.calls[0][0].where).toEqual({ status: "DRAFT" });
    expect(p).toMatchObject({
      total: 7, willSend: 2, byChannel: { SMS: 1, EMAIL: 1 },
      skipped: { CUSTOMER_OPTED_OUT: 1, NO_CONTACT_FOR_CHANNEL: 1, NOT_DRAFT: 1, PAID: 1, VOID: 1 },
      truncated: false,
    });
    expect(p.invoices[0]).toEqual({ id: "a", invoiceNumber: "INV-a", customerName: "Jo", channel: "EMAIL", skip: null });
  });

  it("reports NO_AVAILABLE_CHANNEL for every otherwise-sendable invoice when neither email nor GHL works", async () => {
    channelCaps.mockResolvedValue(NEITHER);
    const { tp } = makePrisma([inv("a"), inv("b", { status: "PAID" })]);
    const p = await createInvoiceSendBatchService(tp).preview({});
    expect(p.skipped).toEqual({ NO_AVAILABLE_CHANNEL: 1, PAID: 1 });
    expect(p.willSend).toBe(0);
  });

  it("works without GHL: email customers are sendable", async () => {
    channelCaps.mockResolvedValue(EMAIL_ONLY);
    const { tp } = makePrisma([inv("a"), inv("b", { customer: customer({ email: null }) })]);
    const p = await createInvoiceSendBatchService(tp).preview({});
    expect(p).toMatchObject({ willSend: 1, byChannel: { EMAIL: 1 }, skipped: { NO_AVAILABLE_CHANNEL: 1 } });
  });

  it("with ids: validates the size, reports unknown ids and allows resend of SENT invoices", async () => {
    const { prisma, tp } = makePrisma([inv("a", { status: "SENT" })]);
    const svc = createInvoiceSendBatchService(tp);
    await expect(svc.preview({ ids: [] })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_BATCH_SIZE" });
    await expect(svc.preview({ ids: Array(MAX_BATCH + 1).fill("x") })).rejects.toMatchObject({ code: "INVALID_BATCH_SIZE" });
    const p = await svc.preview({ ids: ["a", "a", "zzz"], resend: true });
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["a", "zzz"] } });
    expect(p).toMatchObject({ total: 2, willSend: 1, skipped: { NOT_FOUND: 1 } });
  });

  it("narrows a status selection to the current view and flags truncation at 500", async () => {
    const { prisma, tp } = makePrisma([inv("a")], 900);
    const p = await createInvoiceSendBatchService(tp).preview({ status: "OVERDUE", filters: { customerId: "c9", q: "smith" } });
    const where = prisma.invoice.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "SENT", customerId: "c9" });
    expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(500);
    expect(p).toMatchObject({ truncated: true, totalMatching: 900 });
  });

  it("does not look up GHL when there is nothing to send", async () => {
    const { tp } = makePrisma([]);
    const p = await createInvoiceSendBatchService(tp).preview({});
    expect(p.total).toBe(0);
    expect(channelCaps).not.toHaveBeenCalled();
  });
});

describe("send", () => {
  it("queues one outbox row per sendable invoice with an idempotency key and a batch id", async () => {
    const { prisma, tp } = makePrisma([inv("a"), inv("b", { status: "PAID" }), inv("c", { customer: customer({ phone: null }) })]);
    const res = await createInvoiceSendBatchService(tp).send({ ids: ["a", "b", "c", "gone"] });
    expect(res.queued).toBe(2);
    expect(res.skipped).toEqual([{ id: "gone", reason: "NOT_FOUND" }, { id: "b", reason: "PAID" }]);
    expect(res.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res).not.toHaveProperty("truncated");
    const first = prisma.integrationOutbox.create.mock.calls[0][0].data;
    expect(first).toMatchObject({ eventType: "invoice.send", dedupeKey: "invoice.send:a", batchId: res.batchId });
    expect(first.payload).toEqual({ customerId: "c1", invoiceId: "a", channel: "EMAIL", resend: false, batchId: res.batchId });
    expect(prisma.integrationOutbox.create.mock.calls[1][0].data.payload.channel).toBe("EMAIL");
  });

  it("BUG-001: skipped invoices are recorded under the batch (status skipped + reason) so the batch can always be fetched", async () => {
    const { prisma, tp } = makePrisma([inv("a", { status: "PAID" }), inv("b", { customer: customer({ messagesOptOut: true }) })]);
    const res = await createInvoiceSendBatchService(tp).send({ ids: ["a", "b", "gone"] });
    expect(res.queued).toBe(0);
    expect(prisma.integrationOutbox.create).not.toHaveBeenCalled();
    expect(prisma.integrationOutbox.createMany).toHaveBeenCalledTimes(1);
    const rows = prisma.integrationOutbox.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { eventType: "invoice.send", batchId: res.batchId, status: "skipped", processedAt: expect.any(Date), payload: { invoiceId: "gone", batchId: res.batchId }, lastError: expect.stringMatching(/^NOT_FOUND: /) },
      { eventType: "invoice.send", batchId: res.batchId, status: "skipped", processedAt: expect.any(Date), payload: { invoiceId: "a", customerId: "c1", batchId: res.batchId }, lastError: expect.stringMatching(/^PAID: /) },
      { eventType: "invoice.send", batchId: res.batchId, status: "skipped", processedAt: expect.any(Date), payload: { invoiceId: "b", customerId: "c1", batchId: res.batchId }, lastError: expect.stringMatching(/^CUSTOMER_OPTED_OUT: /) },
    ]);
  });

  it("nothing skipped = no extra write; ALREADY_QUEUED duplicates are not recorded as rows", async () => {
    const { prisma, tp } = makePrisma([inv("a")]);
    await createInvoiceSendBatchService(tp).send({ ids: ["a"] });
    expect(prisma.integrationOutbox.createMany).not.toHaveBeenCalled();
  });

  it("a resend of a SENT invoice is queued with resend=true", async () => {
    const { prisma, tp } = makePrisma([inv("a", { status: "SENT" })]);
    const res = await createInvoiceSendBatchService(tp).send({ status: "SENT", resend: true });
    expect(res.queued).toBe(1);
    expect(prisma.integrationOutbox.create.mock.calls[0][0].data.payload.resend).toBe(true);
    expect(prisma.integrationOutbox.create.mock.calls[0][0].data.dedupeKey).toMatch(/^invoice\.send:a:resend:\d+$/);
  });

  it("returns truncated when more than 500 match", async () => {
    const { tp } = makePrisma([inv("a")], 501);
    expect((await createInvoiceSendBatchService(tp).send({})).truncated).toBe(true);
  });

  it("a double click is idempotent: an in-flight duplicate is skipped as ALREADY_QUEUED", async () => {
    const { prisma, tp } = makePrisma([inv("a")]);
    prisma.integrationOutbox.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    prisma.integrationOutbox.updateMany.mockResolvedValue({ count: 0 });
    const res = await createInvoiceSendBatchService(tp).send({});
    expect(res).toMatchObject({ queued: 0, skipped: [{ id: "a", reason: "ALREADY_QUEUED" }] });
    expect(prisma.integrationOutbox.updateMany.mock.calls[0][0].where).toEqual({
      dedupeKey: "invoice.send:a", status: { in: ["sent", "failed", "dead", "skipped", "cancelled"] },
    });
  });

  it("re-arms a finished attempt (e.g. a failed send being retried) for the new batch", async () => {
    const { prisma, tp } = makePrisma([inv("a")]);
    prisma.integrationOutbox.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const res = await createInvoiceSendBatchService(tp).send({});
    expect(res.queued).toBe(1);
    expect(prisma.integrationOutbox.updateMany.mock.calls[0][0].data).toMatchObject({ status: "pending", attempts: 0, batchId: res.batchId, runAfter: null });
  });

  it("rethrows unexpected insert errors", async () => {
    const { prisma, tp } = makePrisma([inv("a")]);
    prisma.integrationOutbox.create.mockRejectedValue(new Error("db down"));
    await expect(createInvoiceSendBatchService(tp).send({})).rejects.toThrow("db down");
    prisma.integrationOutbox.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("other", { code: "P2003", clientVersion: "x" }));
    await expect(createInvoiceSendBatchService(tp).send({})).rejects.toThrow("other");
  });
});

describe("getBatch", () => {
  it("maps outbox rows to per-invoice results", async () => {
    const { prisma, tp } = makePrisma();
    const row = (id: string, status: string, lastError: string | null = null) => ({ status, lastError, payload: { invoiceId: id } });
    prisma.integrationOutbox.findMany.mockResolvedValue([
      row("a", "pending"),
      row("b", "sent"),
      row("c", "failed", "NO_CONTACT_FOR_CHANNEL: Customer has no mobile number on file"),
      row("d", "dead", "boom"),
      row("e", "skipped", "CUSTOMER_OPTED_OUT: Customer has opted out of messages"),
      row("f", "cancelled"),
    ]);
    const res = await createInvoiceSendBatchService(tp).getBatch("b1");
    expect(prisma.integrationOutbox.findMany.mock.calls[0][0].where).toEqual({ batchId: "b1", eventType: "invoice.send" });
    expect(res).toMatchObject({ total: 6, done: false, counts: { QUEUED: 1, SENT: 1, FAILED: 2, SKIPPED: 2 } });
    expect(res.results).toEqual([
      { id: "a", status: "QUEUED" },
      { id: "b", status: "SENT" },
      { id: "c", status: "FAILED", code: "NO_CONTACT_FOR_CHANNEL", error: "Customer has no mobile number on file" },
      { id: "d", status: "FAILED", error: "boom" },
      { id: "e", status: "SKIPPED", code: "CUSTOMER_OPTED_OUT", error: "Customer has opted out of messages" },
      { id: "f", status: "SKIPPED" },
    ]);
  });
  it("BUG-001: an all-skipped batch is a valid, finished batch", async () => {
    const { prisma, tp } = makePrisma();
    prisma.integrationOutbox.findMany.mockResolvedValue([
      { status: "skipped", lastError: "NO_AVAILABLE_CHANNEL: No email or SMS channel is available for this customer", payload: { invoiceId: "a" } },
    ]);
    expect(await createInvoiceSendBatchService(tp).getBatch("b")).toEqual({
      batchId: "b", total: 1, done: true, counts: { QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 1 },
      results: [{ id: "a", status: "SKIPPED", code: "NO_AVAILABLE_CHANNEL", error: "No email or SMS channel is available for this customer" }],
    });
  });
  it("is done when nothing is queued, and 404s for an unknown batch", async () => {
    const { prisma, tp } = makePrisma();
    prisma.integrationOutbox.findMany.mockResolvedValue([{ status: "sent", lastError: null, payload: { invoiceId: "a" } }]);
    expect((await createInvoiceSendBatchService(tp).getBatch("b")).done).toBe(true);
    prisma.integrationOutbox.findMany.mockResolvedValue([]);
    await expect(createInvoiceSendBatchService(tp).getBatch("nope")).rejects.toMatchObject({ statusCode: 404, code: "BATCH_NOT_FOUND" });
  });
});

describe("processInvoiceSendRow", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "r1", attempts: 0, payload: { customerId: "c1", invoiceId: "i1", channel: "SMS", resend: false }, ...over,
  });
  const lastUpdate = (p: ReturnType<typeof makePrisma>["prisma"]) => p.integrationOutbox.update.mock.calls.at(-1)![0].data;

  function ready(invoiceStatus = "DRAFT", optedOut = false) {
    const m = makePrisma();
    m.prisma.customer.findUnique.mockResolvedValue({ messagesOptOut: optedOut });
    m.prisma.invoice.findUnique.mockResolvedValue({ status: invoiceStatus });
    sendInvoice.mockResolvedValue({ id: "i1" });
    return m;
  }

  it("claims the row atomically (lease on runAfter) and does nothing when the claim is lost", async () => {
    const { prisma, tp } = ready();
    prisma.integrationOutbox.updateMany.mockResolvedValue({ count: 0 });
    await processInvoiceSendRow(tp, row());
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(prisma.integrationOutbox.update).not.toHaveBeenCalled();
    const claim = prisma.integrationOutbox.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "r1", status: "pending" });
    expect(claim.data.runAfter.getTime()).toBeGreaterThan(Date.now() + CLAIM_LEASE_MS - 5000);
  });

  it("sends through sendInvoice and marks the row sent", async () => {
    const { prisma, tp } = ready();
    await processInvoiceSendRow(tp, row());
    expect(sendInvoice).toHaveBeenCalledWith("i1", { channel: "SMS", resend: false });
    expect(lastUpdate(prisma)).toMatchObject({ status: "sent", lastError: null, runAfter: null });
  });

  it("resend=true sends an invoice that is already SENT", async () => {
    const { tp } = ready("SENT");
    await processInvoiceSendRow(tp, row({ payload: { customerId: "c1", invoiceId: "i1", resend: true } }));
    expect(sendInvoice).toHaveBeenCalledWith("i1", { channel: undefined, resend: true });
  });

  it("skips (never contacts the provider) for opt-out, paid/void/missing invoices and already-sent invoices", async () => {
    let m = ready("DRAFT", true);
    await processInvoiceSendRow(m.tp, row());
    expect(lastUpdate(m.prisma)).toMatchObject({ status: "skipped", lastError: expect.stringContaining("CUSTOMER_OPTED_OUT") });

    m = ready();
    m.prisma.customer.findUnique.mockResolvedValue(null);
    await processInvoiceSendRow(m.tp, row());
    expect(lastUpdate(m.prisma).status).toBe("skipped");

    for (const status of ["PAID", "VOID"]) {
      m = ready(status);
      await processInvoiceSendRow(m.tp, row());
      expect(lastUpdate(m.prisma)).toMatchObject({ status: "skipped", lastError: expect.stringContaining("INVOICE_NOT_SENDABLE") });
    }
    m = ready();
    m.prisma.invoice.findUnique.mockResolvedValue(null);
    await processInvoiceSendRow(m.tp, row());
    expect(lastUpdate(m.prisma).lastError).toContain("INVOICE_NOT_SENDABLE");

    m = ready("SENT");
    await processInvoiceSendRow(m.tp, row());
    expect(lastUpdate(m.prisma)).toMatchObject({ status: "skipped", lastError: expect.stringContaining("INVOICE_ALREADY_SENT") });
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("a payload without invoiceId/customerId fails terminally... via retry accounting", async () => {
    const { prisma, tp } = ready();
    await processInvoiceSendRow(tp, row({ payload: {} }));
    expect(lastUpdate(prisma)).toMatchObject({ status: "pending", attempts: 1, lastError: expect.stringContaining("INVALID_PAYLOAD") });
  });

  it("terminal provider errors fail the row at once", async () => {
    const { prisma, tp } = ready();
    sendInvoice.mockRejectedValue(new AppError(400, "Customer has no mobile number on file", "NO_CONTACT_FOR_CHANNEL"));
    await processInvoiceSendRow(tp, row());
    expect(lastUpdate(prisma)).toMatchObject({ status: "failed", lastError: "NO_CONTACT_FOR_CHANNEL: Customer has no mobile number on file" });
  });

  it("transient errors retry with back-off and the invoice stays unsent", async () => {
    const { prisma, tp } = ready();
    sendInvoice.mockRejectedValue(new AppError(502, "GoHighLevel could not send the message: x", "GHL_SEND_FAILED"));
    await processInvoiceSendRow(tp, row({ attempts: 1 }));
    const data = lastUpdate(prisma);
    expect(data).toMatchObject({ status: "pending", attempts: 2, lastError: expect.stringContaining("GHL_SEND_FAILED") });
    expect(data.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("goes dead after the maximum attempts (plain errors keep their message)", async () => {
    const { prisma, tp } = ready();
    sendInvoice.mockRejectedValue(new Error("socket hang up"));
    await processInvoiceSendRow(tp, row({ attempts: 5 }));
    expect(lastUpdate(prisma)).toMatchObject({ status: "dead", attempts: 6, lastError: "socket hang up", runAfter: null, processedAt: expect.any(Date) });
    expect(console.error).toHaveBeenCalled();
    expect(notifyIntegrationDead).toHaveBeenCalledWith(tp, { id: "r1", eventType: "invoice.send", lastError: "socket hang up" });
    sendInvoice.mockRejectedValue("weird");
    await processInvoiceSendRow(tp, row({ attempts: 0 }));
    expect(lastUpdate(prisma).lastError).toBe("weird");
  });
});
