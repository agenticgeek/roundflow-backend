import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/crypto", () => ({ decrypt: (v: string) => `dec(${v})` }));
const getGcClient = vi.fn((..._a: unknown[]) => ({ gc: true }));
vi.mock("../../integrations/gocardless/client", () => ({ getGcClient: (...a: unknown[]) => getGcClient(...a) }));
const createMandateSetupLink = vi.fn();
const getFulfilledMandate = vi.fn();
const listCollectableMandates = vi.fn();
vi.mock("../../integrations/gocardless/mandate", () => ({
  createMandateSetupLink: (...a: unknown[]) => createMandateSetupLink(...a),
  getFulfilledMandate: (...a: unknown[]) => getFulfilledMandate(...a),
  listCollectableMandates: (...a: unknown[]) => listCollectableMandates(...a),
}));
const send = vi.fn();
const sendBest = vi.fn();
vi.mock("../message.service", () => ({ createMessageService: () => ({ send, sendBest }) }));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

import {
  AUTO_RESEND_GAP_MS,
  DD_SETUP_LINK_EVENT,
  createDirectDebitService,
  getTenantGcClient,
  normPhone,
  queueDdSetupLink,
} from "../direct-debit.service";

const DAY = 24 * 60 * 60 * 1000;
const CONNECTED = { gocardlessConnected: true, gocardlessAccessTokenEncrypted: "tok", gocardlessEnvironment: "live" };

function customer(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Amelia Jones",
    email: "a@x.com",
    gocardlessMandateId: null,
    gocardlessMandateStatus: null,
    ddSetupLinkUrl: null,
    ddSetupLinkSentAt: null,
    ddSetupLinkExpiresAt: null,
    ...over,
  };
}

function makeTp() {
  return {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(CONNECTED) },
    customer: {
      findUnique: vi.fn().mockResolvedValue(customer()),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
}
type Tp = ReturnType<typeof makeTp>;
const svcOf = (tp: Tp, actor = {}) => createDirectDebitService(tp as never, actor);

let tp: Tp;
beforeEach(() => {
  vi.clearAllMocks();
  tp = makeTp();
  getCachedBusinessSettings.mockResolvedValue({ businessName: "Shine Ltd", gocardlessConnected: true });
  createMandateSetupLink.mockResolvedValue({ billingRequestId: "BRQ1", url: "https://gc/BRQ1", expiresAt: new Date(Date.now() + 7 * DAY) });
  send.mockResolvedValue({ status: "sent", channel: "EMAIL", messageId: "m1" });
  sendBest.mockResolvedValue({ status: "sent", channel: "SMS", messageId: "m2" });
});

describe("getTenantGcClient", () => {
  it("builds the client from the decrypted token and environment", async () => {
    await expect(getTenantGcClient(tp as never)).resolves.toEqual({ gc: true });
    expect(getGcClient).toHaveBeenCalledWith("dec(tok)", "live");
  });

  it("defaults to sandbox and is null when not connected", async () => {
    tp.businessSettings.findFirst.mockResolvedValueOnce({ ...CONNECTED, gocardlessEnvironment: null });
    await getTenantGcClient(tp as never);
    expect(getGcClient).toHaveBeenLastCalledWith("dec(tok)", "sandbox");
    tp.businessSettings.findFirst.mockResolvedValueOnce({ ...CONNECTED, gocardlessConnected: false });
    await expect(getTenantGcClient(tp as never)).resolves.toBeNull();
    tp.businessSettings.findFirst.mockResolvedValueOnce({ ...CONNECTED, gocardlessAccessTokenEncrypted: null });
    await expect(getTenantGcClient(tp as never)).resolves.toBeNull();
    tp.businessSettings.findFirst.mockResolvedValueOnce(null);
    await expect(getTenantGcClient(tp as never)).resolves.toBeNull();
  });
});

describe("normPhone", () => {
  it("folds +44 / 0044 to a leading 0 and drops short or empty numbers", () => {
    expect(normPhone("+44 7700 900123")).toBe("07700900123");
    expect(normPhone("0044 7700 900123")).toBe("07700900123");
    expect(normPhone("07700-900123")).toBe("07700900123");
    expect(normPhone("123")).toBeNull();
    expect(normPhone(null)).toBeNull();
    expect(normPhone("")).toBeNull();
  });
});

describe("queueDdSetupLink", () => {
  it("queues an outbox row for a customer with no mandate", async () => {
    await expect(queueDdSetupLink(tp as never, "c1")).resolves.toBe("queued");
    expect(tp.integrationOutbox.create).toHaveBeenCalledWith({ data: { eventType: DD_SETUP_LINK_EVENT, payload: { customerId: "c1" } } });
  });

  it("queues nothing when GoCardless is not connected or a mandate is in place", async () => {
    getCachedBusinessSettings.mockResolvedValueOnce({ gocardlessConnected: false });
    await expect(queueDdSetupLink(tp as never, "c1")).resolves.toBe("not_connected");
    getCachedBusinessSettings.mockResolvedValueOnce(null);
    await expect(queueDdSetupLink(tp as never, "c1")).resolves.toBe("not_connected");
    tp.customer.findUnique.mockResolvedValueOnce({ gocardlessMandateStatus: "active" });
    await expect(queueDdSetupLink(tp as never, "c1")).resolves.toBe("mandate_exists");
    expect(tp.integrationOutbox.create).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("reports the mandate and a still-valid link", async () => {
    const exp = new Date(Date.now() + DAY);
    const sent = new Date("2026-11-18T10:00:00Z");
    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkUrl: "https://gc/x", ddSetupLinkExpiresAt: exp, ddSetupLinkSentAt: sent }));
    await expect(svcOf(tp).status("c1")).resolves.toEqual({
      gocardlessConnected: true,
      mandateStatus: null,
      mandateId: null,
      linkSentAt: sent,
      linkUrl: "https://gc/x",
      linkExpiresAt: exp,
    });
  });

  it("hides an expired link and reports not connected", async () => {
    getCachedBusinessSettings.mockResolvedValue(null);
    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkUrl: "https://gc/x", ddSetupLinkExpiresAt: new Date(Date.now() - 1000) }));
    await expect(svcOf(tp).status("c1")).resolves.toMatchObject({ gocardlessConnected: false, linkUrl: null, linkExpiresAt: null });
  });

  it("404s for an unknown customer", async () => {
    tp.customer.findUnique.mockResolvedValue(null);
    await expect(svcOf(tp).status("nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("link", () => {
  it("makes a new link and stores it", async () => {
    const res = await svcOf(tp).link("c1");
    expect(res.url).toBe("https://gc/BRQ1");
    expect(createMandateSetupLink).toHaveBeenCalledWith({ gc: true }, expect.objectContaining({ id: "c1" }), "Direct Debit for Shine Ltd");
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { gocardlessBillingRequestId: "BRQ1", ddSetupLinkUrl: "https://gc/BRQ1", ddSetupLinkExpiresAt: expect.any(Date) },
    });
  });

  it("describes the mandate generically when there is no business name", async () => {
    getCachedBusinessSettings.mockResolvedValue({ businessName: "  " });
    await svcOf(tp).link("c1");
    expect(createMandateSetupLink).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "Direct Debit for window cleaning");
    getCachedBusinessSettings.mockResolvedValue(null);
    await svcOf(tp).link("c1");
    expect(createMandateSetupLink).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "Direct Debit for window cleaning");
  });

  it("reuses a stored link with more than an hour left, but not one about to expire", async () => {
    const exp = new Date(Date.now() + 2 * 60 * 60 * 1000);
    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkUrl: "https://gc/old", ddSetupLinkExpiresAt: exp }));
    await expect(svcOf(tp).link("c1")).resolves.toEqual({ url: "https://gc/old", expiresAt: exp });
    expect(createMandateSetupLink).not.toHaveBeenCalled();

    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkUrl: "https://gc/old", ddSetupLinkExpiresAt: new Date(Date.now() + 60_000) }));
    await expect(svcOf(tp).link("c1")).resolves.toMatchObject({ url: "https://gc/BRQ1" });
  });

  it("409s when a mandate is in place or GoCardless is not connected", async () => {
    tp.customer.findUnique.mockResolvedValue(customer({ gocardlessMandateStatus: "pending_submission" }));
    await expect(svcOf(tp).link("c1")).rejects.toMatchObject({ statusCode: 409, code: "MANDATE_EXISTS" });
    tp.customer.findUnique.mockResolvedValue(customer({ gocardlessMandateStatus: "cancelled" }));
    tp.businessSettings.findFirst.mockResolvedValue(null);
    await expect(svcOf(tp).link("c1")).rejects.toMatchObject({ statusCode: 409, code: "GOCARDLESS_NOT_CONNECTED" });
  });
});

describe("sendLink (office)", () => {
  it("renders the template with the link and sends it on the chosen channel", async () => {
    tp.messageTemplate.findFirst.mockResolvedValue({ id: "tpl1", body: "Hi {{firstName}}: {{paymentLink}} {{businessName}}", subject: "DD for {{customerName}}" });
    const res = await svcOf(tp, { id: "p1", role: "ADMIN" }).sendLink("c1", { channel: "EMAIL" });
    expect(send).toHaveBeenCalledWith({
      customerId: "c1",
      channel: "EMAIL",
      body: "Hi Amelia: https://gc/BRQ1 Shine Ltd",
      subject: "DD for Amelia Jones",
      templateId: "tpl1",
    });
    expect(res).toMatchObject({ status: "sent", channel: "EMAIL", url: "https://gc/BRQ1" });
    expect(tp.customer.update).toHaveBeenLastCalledWith({ where: { id: "c1" }, data: { ddSetupLinkSentAt: expect.any(Date) } });
    expect(tp.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "DD_SETUP_LINK_SENT", entityId: "c1", actorId: "p1", actorRole: "ADMIN", details: { channel: "EMAIL", automated: false } }),
    });
  });

  it("uses the built-in body and subject when the tenant has no template", async () => {
    getCachedBusinessSettings.mockResolvedValue(null);
    await svcOf(tp).sendLink("c1");
    const call = send.mock.calls[0][0];
    expect(call.body).toContain("https://gc/BRQ1");
    expect(call.subject).toBe("Set up your Direct Debit");
    expect(call.channel).toBeUndefined();
    expect(tp.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: null, actorRole: null }) });
  });

  it("throws (does not skip) when it cannot send", async () => {
    tp.customer.findUnique.mockResolvedValue(customer({ gocardlessMandateStatus: "active" }));
    await expect(svcOf(tp).sendLink("c1")).rejects.toMatchObject({ code: "MANDATE_EXISTS" });
  });
});

describe("sendLink (automated)", () => {
  it("sends on the best channel", async () => {
    const res = await svcOf(tp).sendLink("c1", { automated: true });
    expect(sendBest).toHaveBeenCalledWith(expect.objectContaining({ customerId: "c1" }));
    expect(res).toMatchObject({ status: "sent", channel: "SMS" });
    expect(tp.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ details: { channel: "SMS", automated: true } }) });
  });

  it("skips with a reason instead of throwing", async () => {
    tp.customer.findUnique.mockResolvedValue(customer({ gocardlessMandateStatus: "active" }));
    await expect(svcOf(tp).sendLink("c1", { automated: true })).resolves.toEqual({ status: "skipped", reason: "MANDATE_EXISTS" });

    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkSentAt: new Date(Date.now() - DAY) }));
    await expect(svcOf(tp).sendLink("c1", { automated: true })).resolves.toEqual({ status: "skipped", reason: "RECENTLY_SENT" });

    tp.customer.findUnique.mockResolvedValue(customer());
    tp.businessSettings.findFirst.mockResolvedValueOnce(null);
    await expect(svcOf(tp).sendLink("c1", { automated: true })).resolves.toEqual({ status: "skipped", reason: "GOCARDLESS_NOT_CONNECTED" });

    sendBest.mockResolvedValueOnce({ status: "skipped", reason: "CUSTOMER_OPTED_OUT" });
    await expect(svcOf(tp).sendLink("c1", { automated: true })).resolves.toEqual({ status: "skipped", reason: "CUSTOMER_OPTED_OUT" });
    expect(tp.activityLog.create).not.toHaveBeenCalled();
  });

  it("re-sends once the gap has passed", async () => {
    tp.customer.findUnique.mockResolvedValue(customer({ ddSetupLinkSentAt: new Date(Date.now() - AUTO_RESEND_GAP_MS - 1000) }));
    await expect(svcOf(tp).sendLink("c1", { automated: true })).resolves.toMatchObject({ status: "sent" });
  });
});

describe("handleBillingRequestFulfilled", () => {
  const fulfilled = { mandateId: "MD1", gcCustomerId: "CU1", rfCustomerId: "c1", status: "pending_submission" };

  it("links the mandate to the customer the request was made for", async () => {
    getFulfilledMandate.mockResolvedValue(fulfilled);
    tp.customer.findUnique.mockResolvedValueOnce({ id: "c1", name: "Amelia Jones" });
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");
    expect(tp.customer.findUnique).toHaveBeenCalledWith({ where: { gocardlessBillingRequestId: "BRQ1" }, select: { id: true, name: true } });
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { gocardlessMandateId: "MD1", gocardlessCustomerId: "CU1", gocardlessMandateStatus: "pending_submission", ddSetupLinkUrl: null, ddSetupLinkExpiresAt: null },
    });
    expect(tp.activityLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: "DIRECT_DEBIT_SET_UP", entityId: "c1" }) });
  });

  it("falls back to the customer id in the request metadata", async () => {
    getFulfilledMandate.mockResolvedValue(fulfilled);
    tp.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "c1", name: "Amelia Jones" });
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");
    expect(tp.customer.findUnique).toHaveBeenLastCalledWith({ where: { id: "c1" }, select: { id: true, name: true } });
    expect(tp.customer.update).toHaveBeenCalled();
  });

  it("does nothing when not connected, no mandate was made, or the customer is unknown", async () => {
    tp.businessSettings.findFirst.mockResolvedValueOnce(null);
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");
    expect(getFulfilledMandate).not.toHaveBeenCalled();

    getFulfilledMandate.mockResolvedValueOnce(null);
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");

    getFulfilledMandate.mockResolvedValueOnce({ ...fulfilled, rfCustomerId: null });
    tp.customer.findUnique.mockResolvedValueOnce(null);
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");

    getFulfilledMandate.mockResolvedValueOnce(fulfilled);
    tp.customer.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await svcOf(tp).handleBillingRequestFulfilled("BRQ1");
    expect(tp.customer.update).not.toHaveBeenCalled();
  });
});

describe("importCandidates", () => {
  const m = (over: Record<string, unknown>) => ({
    mandateId: "MD1", status: "active", reference: null, createdAt: null, gcCustomerId: "CU1",
    name: "Oliver Smith", email: null, phone: null, postcode: null, ...over,
  });

  it("suggests a unique email match, else a unique phone match, and flags ambiguity and existing links", async () => {
    listCollectableMandates.mockResolvedValue([
      m({ mandateId: "MD1", email: "OLIVER@x.com" }),
      m({ mandateId: "MD2", phone: "+44 7700 900002" }),
      m({ mandateId: "MD3", email: "twin@x.com" }),
      m({ mandateId: "MD4", email: "nobody@x.com" }),
      m({ mandateId: "MD5" }),
    ]);
    tp.customer.findMany.mockResolvedValue([
      { id: "c1", name: "Oliver Smith", email: " oliver@x.com ", phone: null, gocardlessMandateId: "MD1" },
      { id: "c2", name: "Bea", email: null, phone: "07700900002", gocardlessMandateId: null },
      { id: "c3", name: "Twin A", email: "twin@x.com", phone: null, gocardlessMandateId: null },
      { id: "c4", name: "Twin B", email: "TWIN@x.com", phone: "1", gocardlessMandateId: null },
      { id: "c5", name: "Blank", email: "   ", phone: null, gocardlessMandateId: null },
    ]);
    const { rows } = await svcOf(tp).importCandidates();
    expect(rows.map((r) => [r.mandateId, r.linkedCustomerId, r.suggestion, r.ambiguous])).toEqual([
      ["MD1", "c1", { customerId: "c1", customerName: "Oliver Smith", matchedBy: "email" }, false],
      ["MD2", null, { customerId: "c2", customerName: "Bea", matchedBy: "phone" }, false],
      ["MD3", null, null, true],
      ["MD4", null, null, false],
      ["MD5", null, null, false],
    ]);
  });

  it("409s when GoCardless is not connected", async () => {
    tp.businessSettings.findFirst.mockResolvedValue(null);
    await expect(svcOf(tp).importCandidates()).rejects.toMatchObject({ code: "GOCARDLESS_NOT_CONNECTED" });
  });
});

describe("importMandates", () => {
  beforeEach(() => {
    listCollectableMandates.mockResolvedValue([
      { mandateId: "MD1", status: "active", gcCustomerId: "CU1" },
      { mandateId: "MD2", status: "submitted", gcCustomerId: "CU2" },
      { mandateId: "MD3", status: "active", gcCustomerId: "CU3" },
      { mandateId: "MD4", status: "active", gcCustomerId: "CU4" },
    ]);
  });

  it("links valid pairs and reports why the others failed", async () => {
    tp.customer.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      ({
        c1: { id: "c1", name: "One", gocardlessMandateId: null, gocardlessMandateStatus: null },
        c2: { id: "c2", name: "Two", gocardlessMandateId: "MDX", gocardlessMandateStatus: "active" },
        c3: { id: "c3", name: "Three", gocardlessMandateId: "MD3", gocardlessMandateStatus: "active" },
        c4: { id: "c4", name: "Four", gocardlessMandateId: null, gocardlessMandateStatus: null },
      })[where.id] ?? null,
    );
    tp.customer.findFirst.mockImplementation(async ({ where }: { where: { gocardlessMandateId: string } }) =>
      where.gocardlessMandateId === "MD4" ? { name: "Someone Else" } : null,
    );

    const res = await svcOf(tp).importMandates([
      { mandateId: "MD1", customerId: "c1" },
      { mandateId: "MD9", customerId: "c1" },
      { mandateId: "MD2", customerId: "c1" },
      { mandateId: "MD2", customerId: "nope" },
      { mandateId: "MD2", customerId: "c2" },
      { mandateId: "MD3", customerId: "c3" },
      { mandateId: "MD4", customerId: "c4" },
    ]);

    expect(res.linked).toBe(2);
    expect(res.failed).toBe(5);
    expect(res.results.map((r) => [r.mandateId, r.customerId, r.status, r.error ?? null])).toEqual([
      ["MD1", "c1", "linked", null],
      ["MD9", "c1", "failed", "Mandate not found in GoCardless, or it can no longer collect"],
      ["MD2", "c1", "failed", "Customer chosen for more than one mandate"],
      ["MD2", "nope", "failed", "Customer not found"],
      ["MD2", "c2", "failed", "Two already has another Direct Debit"],
      ["MD3", "c3", "linked", null],
      ["MD4", "c4", "failed", "Mandate is already linked to Someone Else"],
    ]);
    expect(tp.customer.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { gocardlessMandateId: "MD1", gocardlessCustomerId: "CU1", gocardlessMandateStatus: "active" },
    });
    expect(tp.activityLog.create).toHaveBeenCalledTimes(2);
  });
});
