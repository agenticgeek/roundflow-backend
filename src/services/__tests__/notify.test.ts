import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const profileFindMany = vi.fn();
const tenantFindUnique = vi.fn();
vi.mock("../../lib/prisma", () => ({
  prisma: {
    profile: { findMany: (...a: unknown[]) => profileFindMany(...a) },
    tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) },
  },
}));

const getSchemaNameForClient = vi.fn();
const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getSchemaNameForClient: (...a: unknown[]) => getSchemaNameForClient(...a),
  getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...a),
}));

const create = vi.fn();
vi.mock("../../mobile/services/notification.service", () => ({
  createNotificationService: () => ({ create: (...a: unknown[]) => create(...a) }),
}));

import { notifyEvent, notifyAdmins, notifyTenantAdmins, notifyVisitTechnicians, visitCount, notifyInvoicePaid, notifyPaymentFailed, notifyPaymentEvent, notifyIntegrationDead } from "../notify";

function makeTp() {
  return {
    customer: { findUnique: vi.fn().mockResolvedValue({ name: "Jane Doe" }) },
    technician: { findMany: vi.fn().mockResolvedValue([]) },
    notification: { findFirst: vi.fn().mockResolvedValue(null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "n" });
  getSchemaNameForClient.mockReturnValue("t_abc");
  profileFindMany.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

const base = { type: "SCHEDULE", title: "T", body: "B", data: { roundId: "r1" } } as const;

// Profile lookups: the tenant-admin query carries `where.tenant`; the
// preference query carries `where.id`.
function profiles(opts: { admins?: Array<{ id: string }>; prefs?: Array<{ id: string; preferences: unknown }> }) {
  profileFindMany.mockImplementation(async (args: { where: { tenant?: unknown } }) =>
    args.where.tenant ? (opts.admins ?? []) : (opts.prefs ?? [])
  );
}

describe("notifyEvent recipients", () => {
  it("notifies active technicians with an accepted profile, once each, with data and push on", async () => {
    const tp = makeTp();
    tp.technician.findMany.mockResolvedValue([{ profileId: "p1" }, { profileId: "p1" }, { profileId: "p2" }]);
    profiles({ prefs: [{ id: "p1", preferences: null }, { id: "p2", preferences: null }] });

    const n = await notifyEvent(tp as never, { ...base, to: { technicianIds: ["t1", "t2"] } });

    expect(n).toBe(2);
    expect(tp.technician.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "t2"] }, active: true, profileId: { not: null } },
      select: { profileId: true },
    });
    expect(create).toHaveBeenCalledWith("p1", "SCHEDULE", "T", "B", { roundId: "r1" }, { push: true });
    expect(create).toHaveBeenCalledWith("p2", "SCHEDULE", "T", "B", { roundId: "r1" }, { push: true });
  });

  it("resolves ADMIN and MANAGER profiles of the client's tenant for admins:true", async () => {
    const tp = makeTp();
    profiles({
      admins: [{ id: "admin-1" }, { id: "mgr-1" }],
      prefs: [{ id: "admin-1", preferences: null }, { id: "mgr-1", preferences: null }],
    });
    const n = await notifyEvent(tp as never, { type: "PAYMENT", title: "Failed", to: { admins: true } });
    expect(n).toBe(2);
    expect(profileFindMany).toHaveBeenCalledWith({
      where: { tenant: { schemaName: "t_abc" }, role: { in: ["ADMIN", "MANAGER"] } },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith("admin-1", "PAYMENT", "Failed", undefined, undefined, { push: true });
  });

  it("skips admins when the client cannot be mapped to a tenant", async () => {
    getSchemaNameForClient.mockReturnValue(undefined);
    const tp = makeTp();
    expect(await notifyEvent(tp as never, { type: "PAYMENT", title: "x", to: { admins: true } })).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("merges explicit profile ids, dedupes across sources and honours excludeProfileIds", async () => {
    const tp = makeTp();
    tp.technician.findMany.mockResolvedValue([{ profileId: "p1" }]);
    profiles({
      admins: [{ id: "p1" }, { id: "admin-1" }],
      prefs: [{ id: "admin-1", preferences: null }, { id: "p3", preferences: null }],
    });
    const n = await notifyEvent(tp as never, {
      ...base,
      to: { technicianIds: ["t1"], admins: true, profileIds: ["p3", "p1"], excludeProfileIds: ["p1"] },
    });
    expect(n).toBe(2);
    expect(create.mock.calls.map((c) => c[0]).sort()).toEqual(["admin-1", "p3"]);
  });

  it("does nothing (no queries) when there are no recipients", async () => {
    const tp = makeTp();
    expect(await notifyEvent(tp as never, { ...base, to: { technicianIds: [] } })).toBe(0);
    expect(await notifyEvent(tp as never, { ...base, to: {} })).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(profileFindMany).not.toHaveBeenCalled();
  });
});

describe("notifyEvent preferences", () => {
  it("passes push:false for a profile that opted the category out, push:true for the rest", async () => {
    const tp = makeTp();
    profiles({
      prefs: [
        { id: "p1", preferences: { notifications: { categories: { SCHEDULE: false } } } },
        { id: "p2", preferences: null },
      ],
    });
    await notifyEvent(tp as never, { ...base, to: { profileIds: ["p1", "p2"] } });
    expect(create).toHaveBeenCalledWith("p1", "SCHEDULE", "T", "B", { roundId: "r1" }, { push: false });
    expect(create).toHaveBeenCalledWith("p2", "SCHEDULE", "T", "B", { roundId: "r1" }, { push: true });
  });

  it("fails open (push on) when the preference lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = makeTp();
    profileFindMany.mockRejectedValue(new Error("db"));
    const n = await notifyEvent(tp as never, { ...base, to: { profileIds: ["p1"] } });
    expect(n).toBe(1);
    expect(create).toHaveBeenCalledWith("p1", "SCHEDULE", "T", "B", { roundId: "r1" }, { push: true });
    expect(spy).toHaveBeenCalled();
  });
});

describe("notifyEvent dedupe", () => {
  it("skips a recipient with an unread same-type, same-key notification inside the window", async () => {
    const tp = makeTp();
    profiles({ prefs: [{ id: "a1", preferences: null }, { id: "a2", preferences: null }] });
    tp.notification.findFirst.mockImplementation(async (args: { where: { profileId: string } }) =>
      args.where.profileId === "a1" ? { id: "old" } : null
    );
    const n = await notifyEvent(tp as never, {
      type: "CHAT",
      title: "New message",
      data: { roundId: "r1" },
      to: { profileIds: ["a1", "a2"] },
      dedupe: { windowMs: 300_000, keys: ["roundId"] },
    });
    expect(n).toBe(1);
    expect(create.mock.calls.map((c) => c[0])).toEqual(["a2"]);
    const where = tp.notification.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ profileId: "a1", type: "CHAT", read: false, AND: [{ data: { path: ["roundId"], equals: "r1" } }] });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(299_000);
  });

  it("ignores dedupe keys the event data does not carry", async () => {
    const tp = makeTp();
    profiles({ prefs: [{ id: "a1", preferences: null }] });
    await notifyEvent(tp as never, {
      type: "CHAT",
      title: "x",
      to: { profileIds: ["a1"] },
      dedupe: { windowMs: 1000, keys: ["roundId"] },
    });
    expect(tp.notification.findFirst.mock.calls[0][0].where.AND).toEqual([]);
  });
});

describe("notifyEvent never throws", () => {
  it("logs and returns 0 on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = makeTp();
    tp.technician.findMany.mockRejectedValue(new Error("db down"));
    await expect(notifyEvent(tp as never, { ...base, to: { technicianIds: ["t1"] } })).resolves.toBe(0);
    expect(spy).toHaveBeenCalledWith("[notify] SCHEDULE failed:", expect.any(Error));
  });

  it("counts only successful creates when one recipient fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tp = makeTp();
    profiles({ prefs: [{ id: "p1", preferences: null }, { id: "p2", preferences: null }] });
    create.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ id: "n" });
    expect(await notifyEvent(tp as never, { ...base, to: { profileIds: ["p1", "p2"] } })).toBe(1);
    expect(spy).toHaveBeenCalledWith("[notify] SCHEDULE failed for a recipient:", expect.any(Error));
  });
});

describe("notifyAdmins / notifyTenantAdmins", () => {
  it("notifyAdmins targets the tenant's ADMIN+MANAGER and honours excludeProfileIds", async () => {
    const tp = makeTp();
    profiles({ admins: [{ id: "a1" }, { id: "a2" }], prefs: [{ id: "a2", preferences: null }] });
    expect(await notifyAdmins(tp as never, { type: "COMPLAINT", title: "New complaint", excludeProfileIds: ["a1"] })).toBe(1);
    expect(create.mock.calls.map((c) => c[0])).toEqual(["a2"]);
  });

  it("notifyTenantAdmins resolves the tenant's schema client first", async () => {
    const tp = makeTp();
    tenantFindUnique.mockResolvedValue({ schemaName: "t_abc" });
    getTenantPrismaForSchema.mockReturnValue(tp);
    profiles({ admins: [{ id: "a1" }], prefs: [{ id: "a1", preferences: null }] });
    expect(await notifyTenantAdmins("tenant-1", { type: "INVITE", title: "Invite accepted" })).toBe(1);
    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { id: "tenant-1" }, select: { schemaName: true } });
    expect(getTenantPrismaForSchema).toHaveBeenCalledWith("t_abc");
  });

  it("notifyTenantAdmins is a no-op for an unknown tenant and never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    tenantFindUnique.mockResolvedValueOnce(null);
    expect(await notifyTenantAdmins("nope", { type: "INVITE", title: "x" })).toBe(0);
    tenantFindUnique.mockRejectedValueOnce(new Error("db"));
    expect(await notifyTenantAdmins("t", { type: "INVITE", title: "x" })).toBe(0);
    expect(spy).toHaveBeenCalledWith("[notify] INVITE failed:", expect.any(Error));
  });
});

describe("notifyVisitTechnicians", () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  function techProfile(tp: ReturnType<typeof makeTp>) {
    tp.technician.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ profileId: `prof-${id}` }))
    );
    profileFindMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, preferences: null }))
    );
  }

  it("sends one notification per technician with count, earliest date and a shared roundId", async () => {
    const tp = makeTp();
    techProfile(tp);
    await notifyVisitTechnicians(
      tp as never,
      [
        { id: "v1", technicianId: "t1", date: d("2026-11-16"), roundId: "r1", propertyId: "p1" },
        { id: "v2", technicianId: "t1", date: d("2026-11-09"), roundId: "r1" },
        { id: "v3", technicianId: "t2", date: d("2026-11-10"), roundId: "r2", propertyId: "p3" },
        { id: "v4", technicianId: null, date: d("2026-11-10"), roundId: "r2" },
      ],
      ({ count, first }) => ({ type: "SCHEDULE", title: `${visitCount(count)} cancelled`, body: `from ${first}` }),
      { customerId: "c1" }
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith("prof-t1", "SCHEDULE", "2 visits cancelled", "from 2026-11-09", { roundId: "r1", date: "2026-11-09", customerId: "c1" }, { push: true });
    expect(create).toHaveBeenCalledWith("prof-t2", "SCHEDULE", "1 visit cancelled", "from 2026-11-10", { visitId: "v3", propertyId: "p3", roundId: "r2", date: "2026-11-10", customerId: "c1" }, { push: true });
  });

  it("omits roundId when the technician's visits span rounds, and propertyId when absent", async () => {
    const tp = makeTp();
    techProfile(tp);
    await notifyVisitTechnicians(
      tp as never,
      [
        { id: "v1", technicianId: "t1", date: d("2026-11-09"), roundId: "r1" },
        { id: "v2", technicianId: "t1", date: d("2026-11-09"), roundId: "r2" },
        { id: "v3", technicianId: "t2", date: d("2026-11-09"), roundId: null },
      ],
      () => ({ type: "SCHEDULE", title: "x" })
    );
    expect(create).toHaveBeenCalledWith("prof-t1", "SCHEDULE", "x", undefined, { date: "2026-11-09" }, { push: true });
    expect(create).toHaveBeenCalledWith("prof-t2", "SCHEDULE", "x", undefined, { visitId: "v3", date: "2026-11-09" }, { push: true });
  });

  it("does nothing when no visit has a technician", async () => {
    const tp = makeTp();
    await notifyVisitTechnicians(tp as never, [{ id: "v1", technicianId: null, date: d("2026-11-09") }], () => ({ type: "SCHEDULE", title: "x" }));
    expect(create).not.toHaveBeenCalled();
  });
});

describe("notifyInvoicePaid / notifyPaymentFailed", () => {
  const inv = { id: "inv1", invoiceNumber: "INV-7", customerId: "c1" };

  it("invoice paid: PAYMENT notification to the office with invoice and customer ids, minus the actor", async () => {
    const tp = makeTp();
    profiles({ admins: [{ id: "a1" }, { id: "a2" }], prefs: [{ id: "a2", preferences: null }] });
    await notifyInvoicePaid(tp as never, inv, "a1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("a2", "PAYMENT", "Invoice paid", "Jane Doe paid invoice INV-7.", { invoiceId: "inv1", customerId: "c1" }, { push: true });
  });

  it("invoice paid: nobody excluded when no actor, unknown customer falls back, errors are swallowed", async () => {
    const tp = makeTp();
    tp.customer.findUnique.mockResolvedValueOnce(null);
    profiles({ admins: [{ id: "a1" }], prefs: [{ id: "a1", preferences: null }] });
    await notifyInvoicePaid(tp as never, inv);
    expect(create).toHaveBeenCalledWith("a1", "PAYMENT", "Invoice paid", "A customer paid invoice INV-7.", expect.anything(), { push: true });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    tp.customer.findUnique.mockRejectedValueOnce(new Error("db"));
    await expect(notifyInvoicePaid(tp as never, inv)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[notify] PAYMENT failed:", expect.any(Error));
  });

  it("payment failed: PAYMENT notification naming the customer; errors are swallowed", async () => {
    const tp = makeTp();
    profiles({ admins: [{ id: "a1" }], prefs: [{ id: "a1", preferences: null }] });
    await notifyPaymentFailed(tp as never, "c1");
    expect(create).toHaveBeenCalledWith("a1", "PAYMENT", "Payment failed", "A payment from Jane Doe failed.", { customerId: "c1" }, { push: true });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    tp.customer.findUnique.mockRejectedValueOnce(new Error("db"));
    await expect(notifyPaymentFailed(tp as never, "c1")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});

describe("notifyPaymentEvent / notifyIntegrationDead (Wave 2B-1)", () => {
  it("payment event: PAYMENT notification with customer + invoice ids; body falls back; errors swallowed", async () => {
    const tp = makeTp();
    profiles({ admins: [{ id: "a1" }], prefs: [{ id: "a1", preferences: null }] });
    await notifyPaymentEvent(tp as never, { customerId: "c1", invoiceId: "inv1", title: "Payment refunded", body: "Stripe charge.refunded" });
    expect(create).toHaveBeenCalledWith("a1", "PAYMENT", "Payment refunded", "Jane Doe: Stripe charge.refunded", { customerId: "c1", invoiceId: "inv1" }, { push: true });

    create.mockClear();
    await notifyPaymentEvent(tp as never, { customerId: "c1", title: "Payment disputed" });
    expect(create).toHaveBeenCalledWith("a1", "PAYMENT", "Payment disputed", "A payment from Jane Doe needs attention.", { customerId: "c1" }, { push: true });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    tp.customer.findUnique.mockRejectedValueOnce(new Error("db"));
    await expect(notifyPaymentEvent(tp as never, { customerId: "c1", title: "x" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("[notify] PAYMENT failed:", expect.any(Error));
  });

  it("integration dead: INTEGRATION alert to the office, deduped; errors swallowed", async () => {
    const tp = makeTp();
    profiles({ admins: [{ id: "a1" }], prefs: [{ id: "a1", preferences: null }] });
    await notifyIntegrationDead(tp as never, { id: "o1", eventType: "message.send", lastError: "boom" });
    expect(create).toHaveBeenCalledWith("a1", "INTEGRATION", "Integration message failed", expect.stringContaining("message.send"), undefined, { push: true });
    expect(tp.notification.findFirst).toHaveBeenCalled();

    // A failing lookup is swallowed by notifyEvent (logged, nothing created).
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockClear();
    profileFindMany.mockRejectedValue(new Error("db"));
    await expect(notifyIntegrationDead(tp as never, { id: "o2", eventType: "x" })).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });
});
