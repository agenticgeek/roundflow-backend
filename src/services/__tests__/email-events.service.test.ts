import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { applySesEvent, evaluateEmailHealth, parseSesEvent, tenantIdOf } from "../email-events.service";
import { notifyAdmins } from "../notify";

const raw = (eventType: string, extra: Record<string, unknown> = {}) => ({
  eventType,
  mail: { messageId: "ses-1", tags: { tenantId: ["ten1"], messageId: ["msg1"] } },
  ...extra,
});

describe("parseSesEvent", () => {
  it("parses Delivery, Bounce and Complaint", () => {
    expect(parseSesEvent(raw("Delivery", { delivery: {} }))).toEqual({ type: "Delivery", messageId: "ses-1", tenantId: "ten1" });
    expect(parseSesEvent(raw("Bounce", { bounce: { bounceType: "Permanent", bounceSubType: "General" } }))).toEqual({
      type: "Bounce", messageId: "ses-1", tenantId: "ten1", permanent: true, detail: "Permanent/General",
    });
    expect(parseSesEvent(raw("Bounce", { bounce: { bounceType: "Transient", bounceSubType: "MailboxFull" } }))).toMatchObject({ permanent: false, detail: "Transient/MailboxFull" });
    expect(parseSesEvent(raw("Complaint", { complaint: { complaintFeedbackType: "abuse" } }))).toMatchObject({ type: "Complaint", detail: "abuse" });
  });
  it("accepts the legacy notificationType and tolerates missing detail/tags", () => {
    expect(parseSesEvent({ notificationType: "Complaint", mail: { messageId: "m" }, complaint: {} })).toEqual({ type: "Complaint", messageId: "m", tenantId: undefined, detail: "complaint" });
    expect(parseSesEvent({ eventType: "Bounce", mail: { messageId: "m" } })).toMatchObject({ permanent: false, detail: "Transient/Undetermined" });
  });
  it("ignores other event types and malformed payloads", () => {
    for (const bad of [raw("Send"), raw("Open"), { eventType: "Delivery" }, null, "x", { eventType: "Delivery", mail: {} }]) expect(parseSesEvent(bad)).toBeNull();
  });
});

describe("tenantIdOf", () => {
  it("reads the tenantId tag", () => {
    expect(tenantIdOf(raw("Delivery"))).toBe("ten1");
    expect(tenantIdOf({ mail: { tags: { tenantId: [] } } })).toBeUndefined();
    expect(tenantIdOf(null)).toBeUndefined();
    expect(tenantIdOf({ mail: { tags: { tenantId: "plain" } } })).toBeUndefined();
  });
});

type Row = { deliveryStatus: string | null; deliveryError?: string | null };
// findMany serves two queries: the last-100 window, and the 7-day absolute-trigger query (has deliveryUpdatedAt).
function makeTp(window: Row[] = [], message: unknown = { id: "msg1", customerId: "c1" }, recent: Row[] = []) {
  return {
    message: {
      findFirst: vi.fn().mockResolvedValue(message),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(async (arg: { where: { deliveryUpdatedAt?: unknown } }) => (arg.where.deliveryUpdatedAt ? recent : window)),
    },
    customer: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    businessSettings: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}
// "BOUNCED" = permanent bounce, "TRANSIENT" = transient bounce.
const rowOf = (k: string): Row =>
  k === "BOUNCED" ? { deliveryStatus: "BOUNCED", deliveryError: "Permanent/General" }
  : k === "TRANSIENT" ? { deliveryStatus: "BOUNCED", deliveryError: "Transient/MailboxFull" }
  : { deliveryStatus: k, deliveryError: null };
const rows = (n: number, over: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => rowOf(over[i] ?? "DELIVERED"));
const many = (n: number, kind: string) => Array.from({ length: n }, () => rowOf(kind));

beforeEach(() => vi.mocked(notifyAdmins).mockClear());

describe("applySesEvent", () => {
  it("Delivery -> DELIVERED, never downgrading a worse status; no health check", async () => {
    const tp = makeTp();
    await applySesEvent(tp as never, { type: "Delivery", messageId: "ses-1" });
    expect(tp.message.findFirst).toHaveBeenCalledWith({ where: { externalId: "ses-1", channel: "EMAIL", direction: "OUTBOUND" }, select: { id: true, customerId: true } });
    const arg = tp.message.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "msg1", OR: [{ deliveryStatus: null }, { deliveryStatus: { in: ["SENT"] } }] });
    expect(arg.data).toMatchObject({ deliveryStatus: "DELIVERED", deliveryUpdatedAt: expect.any(Date) });
    expect(tp.customer.updateMany).not.toHaveBeenCalled();
    expect(tp.message.findMany).not.toHaveBeenCalled();
  });
  it("permanent bounce -> BOUNCED, flags the customer's email invalid, checks health", async () => {
    const tp = makeTp(rows(10));
    await applySesEvent(tp as never, { type: "Bounce", messageId: "ses-1", permanent: true, detail: "Permanent/General" });
    const arg = tp.message.updateMany.mock.calls[0][0];
    expect(arg.where.OR[1]).toEqual({ deliveryStatus: { in: ["SENT", "DELIVERED"] } });
    expect(arg.data).toMatchObject({ deliveryStatus: "BOUNCED", deliveryError: "Permanent/General" });
    expect(tp.customer.updateMany).toHaveBeenCalledWith({ where: { id: "c1", emailInvalidAt: null }, data: { emailInvalidAt: expect.any(Date) } });
    expect(tp.message.findMany).toHaveBeenCalled();
  });
  it("transient bounce -> BOUNCED but the address stays valid", async () => {
    const tp = makeTp(rows(10));
    await applySesEvent(tp as never, { type: "Bounce", messageId: "ses-1", permanent: false, detail: "Transient/MailboxFull" });
    expect(tp.message.updateMany.mock.calls[0][0].data.deliveryStatus).toBe("BOUNCED");
    expect(tp.customer.updateMany).not.toHaveBeenCalled();
  });
  it("complaint -> COMPLAINED, wins over everything, flags the customer", async () => {
    const tp = makeTp(rows(10));
    await applySesEvent(tp as never, { type: "Complaint", messageId: "ses-1", detail: "abuse" });
    const arg = tp.message.updateMany.mock.calls[0][0];
    expect(arg.where.OR[1]).toEqual({ deliveryStatus: { in: ["SENT", "DELIVERED", "BOUNCED"] } });
    expect(arg.data.deliveryStatus).toBe("COMPLAINED");
    expect(tp.customer.updateMany).toHaveBeenCalled();
  });
  it("an event for an unknown message, or one with no customer, is harmless", async () => {
    const none = makeTp([], null);
    await applySesEvent(none as never, { type: "Bounce", messageId: "x", permanent: true });
    expect(none.message.updateMany).not.toHaveBeenCalled();
    const noCustomer = makeTp(rows(5), { id: "msg1", customerId: null });
    await applySesEvent(noCustomer as never, { type: "Complaint", messageId: "x" });
    expect(noCustomer.customer.updateMany).not.toHaveBeenCalled();
    await applySesEvent(makeTp(rows(5)) as never, { type: "Bounce", messageId: "x", permanent: false });
  });
});

describe("evaluateEmailHealth (auto-pause)", () => {
  const paused = (tp: ReturnType<typeof makeTp>) => tp.businessSettings.updateMany.mock.calls[0][0].data.emailPausedReason as string;

  it("percentage rules need a window of at least 100 sends", async () => {
    const small = makeTp(rows(99, { 0: "COMPLAINED" }));
    expect(await evaluateEmailHealth(small as never)).toBe(false);
    expect(small.businessSettings.updateMany).not.toHaveBeenCalled();
  });
  it("does nothing at or under the thresholds (5% hard bounces is not above 5%)", async () => {
    const healthy = makeTp(rows(100, { 0: "BOUNCED", 1: "BOUNCED", 2: "BOUNCED", 3: "BOUNCED", 4: "BOUNCED" }));
    expect(await evaluateEmailHealth(healthy as never)).toBe(false);
    expect(healthy.businessSettings.updateMany).not.toHaveBeenCalled();
  });
  it("pauses above 0.3% complaints in a 100+ window and tells the admins once", async () => {
    const tp = makeTp(rows(100, { 3: "COMPLAINED" }));
    expect(await evaluateEmailHealth(tp as never)).toBe(true);
    expect(tp.businessSettings.updateMany).toHaveBeenCalledWith({
      where: { emailPausedReason: null },
      data: { emailPausedReason: expect.stringMatching(/Complaint rate 1\.0%.*0\.3%/), emailPausedAt: expect.any(Date) },
    });
    expect(notifyAdmins).toHaveBeenCalledWith(tp, expect.objectContaining({ type: "INTEGRATION", title: "Email sending paused" }));
  });
  it("pauses above 5% PERMANENT bounces", async () => {
    const tp = makeTp(rows(100, Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [i, "BOUNCED"]))));
    expect(await evaluateEmailHealth(tp as never)).toBe(true);
    expect(paused(tp)).toMatch(/Hard bounce rate 6\.0%.*5%/);
  });
  it("transient bounces never count towards the bounce rate", async () => {
    const tp = makeTp(rows(100, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, "TRANSIENT"]))));
    expect(await evaluateEmailHealth(tp as never)).toBe(false);
  });
  it("a bounce with no recorded detail is not treated as permanent", async () => {
    const tp = makeTp(Array.from({ length: 100 }, () => ({ deliveryStatus: "BOUNCED", deliveryError: null })));
    expect(await evaluateEmailHealth(tp as never)).toBe(false);
  });
  it("absolute trigger: 3 complaints within 7 days pause a tiny tenant regardless of volume", async () => {
    const tp = makeTp(rows(10), undefined, many(3, "COMPLAINED"));
    expect(await evaluateEmailHealth(tp as never)).toBe(true);
    expect(paused(tp)).toMatch(/3 complaints in the last 7 days/);
    const where = tp.message.findMany.mock.calls.find((c) => c[0].where.deliveryUpdatedAt)![0].where;
    expect(where).toMatchObject({ channel: "EMAIL", direction: "OUTBOUND", deliveryStatus: { in: ["BOUNCED", "COMPLAINED"] } });
    expect((where.deliveryUpdatedAt as { gte: Date }).gte).toBeInstanceOf(Date);
  });
  it("absolute trigger: 10 permanent bounces within 7 days (transient ones ignored)", async () => {
    const tp = makeTp(rows(10), undefined, [...many(10, "BOUNCED"), ...many(5, "TRANSIENT")]);
    expect(await evaluateEmailHealth(tp as never)).toBe(true);
    expect(paused(tp)).toMatch(/10 hard bounces in the last 7 days/);
    expect(await evaluateEmailHealth(makeTp(rows(10), undefined, [...many(9, "BOUNCED"), ...many(20, "TRANSIENT")]) as never)).toBe(false);
  });
  it("one or two complaints on a small tenant do not pause", async () => {
    expect(await evaluateEmailHealth(makeTp(rows(10), undefined, many(2, "COMPLAINED")) as never)).toBe(false);
  });
  it("already paused: no second notification", async () => {
    const tp = makeTp(rows(100, { 0: "COMPLAINED" }));
    tp.businessSettings.updateMany.mockResolvedValue({ count: 0 });
    expect(await evaluateEmailHealth(tp as never)).toBe(true);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});
