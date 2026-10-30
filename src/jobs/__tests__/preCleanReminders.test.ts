import { it, expect, vi, beforeEach } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({
  getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...a),
}));

import {
  isPreCleanRemindersEnabled,
  resolveTimeZone,
  localDateTime,
  reminderTargetDay,
  renderReminder,
  runTenantPreCleanReminders,
  runPreCleanReminders,
  DEFAULT_REMINDER_BODY,
} from "../preCleanReminders";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function makeTp(opts: {
  settings?: Record<string, unknown> | null;
  visits?: unknown[];
  template?: Record<string, unknown> | null;
  claimed?: number;
} = {}) {
  const tx = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: opts.claimed ?? 1 }) },
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    businessSettings: {
      findFirst: vi.fn().mockResolvedValue(
        opts.settings === undefined
          ? { setupCompleted: true, reminderMode: "EVENING_BEFORE", reminderTime: "19:00", timezone: null, businessName: "Coates" }
          : opts.settings
      ),
    },
    visit: { findMany: vi.fn().mockResolvedValue(opts.visits ?? []) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(opts.template ?? null) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    tx,
  };
}

const visit = (id: string, customer: Partial<{ phone: string | null; email: string | null }> = {}) => ({
  id,
  date: d("2026-10-31"),
  property: {
    addressLine: "1 High St",
    customer: { id: `c-${id}`, name: "Jo Bloggs", phone: "07700900201", email: null, ...customer },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

it("isPreCleanRemindersEnabled reads PRECLEAN_REMINDERS_ENABLED", () => {
  expect(isPreCleanRemindersEnabled({ PRECLEAN_REMINDERS_ENABLED: "true" })).toBe(true);
  expect(isPreCleanRemindersEnabled({ PRECLEAN_REMINDERS_ENABLED: "1" })).toBe(false);
  expect(isPreCleanRemindersEnabled({})).toBe(false);
  expect(typeof isPreCleanRemindersEnabled()).toBe("boolean");
});

it("resolveTimeZone falls back to Europe/London", () => {
  expect(resolveTimeZone(null)).toBe("Europe/London");
  expect(resolveTimeZone("Not/AZone")).toBe("Europe/London");
  expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
});

it("localDateTime and reminderTargetDay respect BST and the GMT changeover", () => {
  // Sat 24 Oct 2026 18:30 UTC = 19:30 BST -> EVENING_BEFORE targets Sun 25 Oct
  expect(localDateTime(new Date("2026-10-24T18:30:00Z"), "Europe/London")).toEqual({ date: "2026-10-24", time: "19:30" });
  expect(reminderTargetDay({ now: new Date("2026-10-24T18:30:00Z"), mode: "EVENING_BEFORE", reminderTime: "19:00", timeZone: "Europe/London" }))
    .toEqual(d("2026-10-25"));
  // Mon 26 Oct 18:30 UTC = 18:30 GMT (clocks went back) -> not yet 19:00
  expect(reminderTargetDay({ now: new Date("2026-10-26T18:30:00Z"), mode: "EVENING_BEFORE", reminderTime: "19:00", timeZone: "Europe/London" }))
    .toBeNull();
  // 23:30 UTC on 31 Mar = 00:30 BST on 1 Apr -> MORNING_OF targets the local day, not the UTC day
  expect(reminderTargetDay({ now: new Date("2026-03-31T23:30:00Z"), mode: "MORNING_OF", reminderTime: "00:15", timeZone: "Europe/London" }))
    .toEqual(d("2026-04-01"));
  expect(reminderTargetDay({ now: new Date(), mode: "NONE", reminderTime: "00:00", timeZone: "Europe/London" })).toBeNull();
});

it("renderReminder fills known variables and blanks unknown ones", () => {
  const vars = { customerName: "Jo", date: "Saturday 31 October", address: "1 High St", businessName: "Coates" };
  expect(renderReminder("Hi [Customer Name], {{ date }} at [Address] / [date] - {{businessName}}{{unknown}}", vars))
    .toBe("Hi Jo, Saturday 31 October at 1 High St / Saturday 31 October - Coates");
});

it("queues one reminder per eligible visit tomorrow and stamps reminderSentAt", async () => {
  const tp = makeTp({
    visits: [visit("v1"), visit("v2", { phone: null, email: "jo@x.com" }), visit("v3", { phone: null })],
    template: { id: "tpl1", channel: "SMS", body: "Hi [Customer Name], see you {{date}}" },
  });
  const now = new Date("2026-10-30T19:05:00Z"); // 19:05 GMT
  await expect(runTenantPreCleanReminders(tp as never, now)).resolves.toBe(2);

  expect(tp.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: {
      date: { gte: d("2026-10-31"), lt: d("2026-11-01") },
      status: "SCHEDULED",
      reminderSentAt: null,
      paymentHold: false,
      property: { customer: { status: "ACTIVE", holdNextClean: false, messagesOptOut: false } },
    },
  }));
  expect(tp.tx.visit.updateMany).toHaveBeenCalledWith({ where: { id: "v1", reminderSentAt: null }, data: { reminderSentAt: now } });
  expect(tp.tx.integrationOutbox.create).toHaveBeenNthCalledWith(1, {
    data: {
      eventType: "message.send",
      payload: {
        customerId: "c-v1", visitId: "v1", channel: "SMS",
        body: "Hi Jo Bloggs, see you Saturday 31 October", templateId: "tpl1", reason: "PRE_CLEAN_REMINDER",
      },
    },
  });
  // no mobile -> falls back to EMAIL; v3 has no contact at all -> skipped
  expect(tp.tx.integrationOutbox.create.mock.calls[1][0].data.payload.channel).toBe("EMAIL");
  expect(tp.tx.integrationOutbox.create).toHaveBeenCalledTimes(2);
});

it("an EMAIL template falls back to SMS when there is no email; default body when no template", async () => {
  const tp = makeTp({
    settings: { setupCompleted: true, reminderMode: "MORNING_OF", reminderTime: "07:00", timezone: "Europe/London", businessName: null },
    visits: [visit("v1"), visit("v2", { phone: null, email: null })],
    template: { id: "t", channel: "EMAIL", body: "{{businessName}}!" },
  });
  await runTenantPreCleanReminders(tp as never, new Date("2026-10-31T08:00:00Z"));
  expect(tp.tx.integrationOutbox.create.mock.calls[0][0].data.payload).toMatchObject({ channel: "SMS", body: "!" });
  expect(tp.tx.integrationOutbox.create).toHaveBeenCalledTimes(1);

  const tp2 = makeTp({ visits: [visit("v1", { email: "a@b.c" })], template: { id: "t", channel: "EMAIL", body: "x" } });
  await runTenantPreCleanReminders(tp2 as never, new Date("2026-10-30T20:00:00Z"));
  expect(tp2.tx.integrationOutbox.create.mock.calls[0][0].data.payload.channel).toBe("EMAIL");

  const tp3 = makeTp({ visits: [visit("v1")] });
  await runTenantPreCleanReminders(tp3 as never, new Date("2026-10-30T20:00:00Z"));
  expect(tp3.tx.integrationOutbox.create.mock.calls[0][0].data.payload).toMatchObject({
    channel: "SMS",
    templateId: null,
    body: DEFAULT_REMINDER_BODY.replace("{{customerName}}", "Jo Bloggs").replace("{{date}}", "Saturday 31 October"),
  });
});

it("skips a visit already claimed by an overlapping run", async () => {
  const tp = makeTp({ visits: [visit("v1")], claimed: 0 });
  await expect(runTenantPreCleanReminders(tp as never, new Date("2026-10-30T20:00:00Z"))).resolves.toBe(0);
  expect(tp.tx.integrationOutbox.create).not.toHaveBeenCalled();
});

it("does nothing before setup completes, before reminderTime, with mode NONE, or with no visits", async () => {
  const late = new Date("2026-10-30T20:00:00Z");
  for (const settings of [null, { setupCompleted: false }]) {
    const tp = makeTp({ settings });
    await expect(runTenantPreCleanReminders(tp as never, late)).resolves.toBe(0);
    expect(tp.visit.findMany).not.toHaveBeenCalled();
  }
  const early = makeTp();
  await expect(runTenantPreCleanReminders(early as never, new Date("2026-10-30T12:00:00Z"))).resolves.toBe(0);
  expect(early.visit.findMany).not.toHaveBeenCalled();
  const none = makeTp({ settings: { setupCompleted: true, reminderMode: "NONE", reminderTime: "19:00", timezone: null } });
  await expect(runTenantPreCleanReminders(none as never, late)).resolves.toBe(0);
  const noVisits = makeTp();
  await expect(runTenantPreCleanReminders(noVisits as never, late)).resolves.toBe(0);
  expect(noVisits.messageTemplate.findFirst).not.toHaveBeenCalled();
});

it("runPreCleanReminders runs every tenant and isolates per-tenant failures", async () => {
  tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }, { schemaName: "t_b" }]);
  const ok = makeTp({ visits: [visit("v1")] });
  const broken = { businessSettings: { findFirst: vi.fn().mockRejectedValue(new Error("db down")) } };
  getTenantPrismaForSchema.mockImplementation((s: string) => (s === "t_a" ? ok : broken));
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await expect(runPreCleanReminders(new Date("2026-10-30T20:00:00Z"))).resolves.toEqual({ tenants: 2, queued: 1 });
  expect(err).toHaveBeenCalledWith(expect.stringContaining("t_b"), expect.any(Error));

  tenantFindMany.mockResolvedValue([]);
  await expect(runPreCleanReminders()).resolves.toEqual({ tenants: 0, queued: 0 });
});
