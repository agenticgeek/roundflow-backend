import { describe, expect, it } from "vitest";
import { listMessagesDelivery } from "../list-messages-delivery";
import { ctxFor, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const OUTBOUND = [
  { channel: "SMS", deliveryStatus: "DELIVERED", _count: 10, _sum: { creditCost: 12 } },
  { channel: "SMS", deliveryStatus: "FAILED", _count: 2, _sum: { creditCost: 0 } },
  { channel: "EMAIL", deliveryStatus: "BOUNCED", _count: 3, _sum: { creditCost: null } },
  { channel: "EMAIL", deliveryStatus: null, _count: 1, _sum: { creditCost: null } },
];
const m = (channel: string, deliveryStatus: string, day: string, name: string | null, creditCost: number | null = null) => ({
  channel, deliveryStatus, createdAt: new Date(`${day}T10:00:00Z`), creditCost, customer: name ? { name } : null, ...SECRETS,
});
const FAILED = [m("SMS", "FAILED", "2026-11-05", "Mrs Smith", 1), m("EMAIL", "BOUNCED", "2026-11-04", null)];
const CONTACTS = [
  { name: "Mr A", messagesOptOut: true, emailInvalidAt: null, ...SECRETS },
  { name: "Mr B", messagesOptOut: false, emailInvalidAt: new Date("2026-10-01T00:00:00Z") },
  { name: "Mr C", messagesOptOut: true, emailInvalidAt: new Date("2026-10-01T00:00:00Z") },
];

const world = () =>
  fakePrisma({
    "message.groupBy": (a: { where: { direction: string } }) => (a.where.direction === "OUTBOUND" ? OUTBOUND : [{ channel: "SMS", _count: 4 }]),
    "message.findMany": FAILED,
    "customer.count": 3,
    "customer.findMany": CONTACTS,
  });

describe("list_messages_delivery", () => {
  it("validates input", () => {
    expect(listMessagesDelivery.parse({})).toEqual({ from: undefined, to: undefined, channel: undefined, status: undefined, limit: 50 });
    expect(listMessagesDelivery.parse({ channel: "SMS", status: "FAILED", limit: 10 })).toMatchObject({ channel: "SMS", status: "FAILED", limit: 10 });
    expect(() => listMessagesDelivery.parse({ channel: "FAX" })).toThrow(/must be one of/);
    expect(() => listMessagesDelivery.parse({ status: "READ" })).toThrow(/must be one of/);
    expect(() => listMessagesDelivery.parse({ limit: 201 })).toThrow(/1 to 200/);
    expect(() => listMessagesDelivery.parse({ body: "x" })).toThrow(/Unknown argument/);
    expect(() => listMessagesDelivery.parse({ from: "nope" })).toThrow(/YYYY-MM-DD/);
    expect(listMessagesDelivery.name).toBe("list_messages_delivery");
    expect(listMessagesDelivery.readOnly).toBe(true);
  });

  it("summarises delivery by channel and status, lists failed messages and uncontactable customers, never the body", async () => {
    const fp = world();
    const out = await listMessagesDelivery.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    const blank = { channel: null, status: null, customer: null, date: null, count: null, credits: null };
    expect(out.rows).toEqual([
      { kind: "Delivery summary", ...blank, channel: "SMS", status: "DELIVERED", count: 10, credits: 12 },
      { kind: "Delivery summary", ...blank, channel: "SMS", status: "FAILED", count: 2, credits: 0 },
      { kind: "Delivery summary", ...blank, channel: "EMAIL", status: "BOUNCED", count: 3, credits: 0 },
      { kind: "Delivery summary", ...blank, channel: "EMAIL", status: null, count: 1, credits: 0 },
      { kind: "Inbound replies", ...blank, channel: "SMS", count: 4 },
      { kind: "Failed message", ...blank, channel: "SMS", status: "FAILED", customer: "Mrs Smith", date: "2026-11-05", credits: 1 },
      { kind: "Failed message", ...blank, channel: "EMAIL", status: "BOUNCED", date: "2026-11-04" },
      { kind: "Cannot be contacted", ...blank, status: "Opted out of messages", customer: "Mr A" },
      { kind: "Cannot be contacted", ...blank, status: "Invalid email", customer: "Mr B" },
      { kind: "Cannot be contacted", ...blank, status: "Opted out and invalid email", customer: "Mr C" },
    ]);
    expect(out.totals).toEqual({ kind: "Total", channel: null, status: null, customer: null, date: null, count: 5, credits: 12, customers: 3 });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["kind", "channel", "status", "customer", "date", "count", "credits"]);
    expectSafe(out, fp);
    const sel = (fp.calls.find((c) => c.path === "message.findMany")!.args as { select: Record<string, unknown> }).select;
    expect(Object.keys(sel).sort()).toEqual(["channel", "createdAt", "creditCost", "customer", "deliveryStatus"]);
  });

  it("filters by channel and status", async () => {
    const fp = world();
    const out = await listMessagesDelivery.run({ channel: "EMAIL", status: "BOUNCED", limit: 50 }, ctxFor(fp.tp));
    expect(out.rows.filter((r) => r.kind === "Delivery summary")).toEqual([expect.objectContaining({ channel: "EMAIL", status: "BOUNCED", count: 3 })]);
    expect(out.totals).toMatchObject({ count: 3 });
    const find = fp.calls.find((c) => c.path === "message.findMany")!.args as { where: { channel: string; deliveryStatus: { in: string[] }; direction: string } };
    expect(find.where).toMatchObject({ channel: "EMAIL", deliveryStatus: { in: ["BOUNCED"] }, direction: "OUTBOUND" });
  });

  it("limit applies to the detail rows: failed first, customers fill what is left, truncation is honest", async () => {
    const fp = fakePrisma({ "message.findMany": FAILED, "customer.count": 3, "customer.findMany": CONTACTS.slice(0, 1) });
    const out = await listMessagesDelivery.run({ limit: 2 }, ctxFor(fp.tp));
    expect(out.rows.map((r) => r.kind)).toEqual(["Failed message", "Failed message"]);
    expect(out.truncated).toBe(true);
    expect(fp.calls.some((c) => c.path === "customer.findMany")).toBe(false);
    const one = await listMessagesDelivery.run({ limit: 1 }, ctxFor(fakePrisma({ "message.findMany": FAILED }).tp));
    expect(one.truncated).toBe(true);
  });

  it("returns empty rows and null totals when nothing happened; rejects a bad range", async () => {
    const fp = fakePrisma();
    expect(await listMessagesDelivery.run({ limit: 50 }, ctxFor(fp.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    await expect(listMessagesDelivery.run({ from: "2026-11-10", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/must not be after/);
  });

  it("buckets messages by tenant-local day (a 23:30 UTC message is next-day in Auckland)", async () => {
    const fp = fakePrisma({ "message.findMany": [{ ...m("SMS", "FAILED", "2026-11-05", "Mrs Smith"), createdAt: new Date("2026-11-05T23:30:00Z") }] }, { timezone: "Pacific/Auckland" });
    const out = await listMessagesDelivery.run({ from: "2026-11-06", to: "2026-11-06", limit: 50 }, ctxFor(fp.tp));
    expect(out.rows[0]).toMatchObject({ kind: "Failed message", date: "2026-11-06" });
    const where = (fp.calls.find((c) => c.path === "message.findMany")!.args as { where: { createdAt: { gte: Date; lt: Date } } }).where.createdAt;
    expect(where.gte.toISOString()).toBe("2026-11-05T11:00:00.000Z");
  });
});
