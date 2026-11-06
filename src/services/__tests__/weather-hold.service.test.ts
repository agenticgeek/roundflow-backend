import { it, expect, vi, describe, beforeEach } from "vitest";

const assertAnyChannelAvailable = vi.fn();
const broadcast = vi.fn();
vi.mock("../message.service", () => ({
  createMessageService: vi.fn(() => ({ assertAnyChannelAvailable, broadcast })),
}));
const tenantToday = vi.fn();
const tenantTodayRange = vi.fn();
const tenantWorkingDays = vi.fn();
vi.mock("../business-time", () => ({
  tenantWorkingDays: (...a: unknown[]) => tenantWorkingDays(...a),
  tenantToday: (...a: unknown[]) => tenantToday(...a),
  tenantTodayRange: (...a: unknown[]) => tenantTodayRange(...a),
}));
const getCachedBusinessSettings = vi.fn();
vi.mock("../settings.service", () => ({ getCachedBusinessSettings: (...a: unknown[]) => getCachedBusinessSettings(...a) }));

vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());

import { createWeatherHoldService, WEATHER_CONDITIONS } from "../weather-hold.service";
import { notifyVisitTechnicians } from "../notify";
import { CleaningFrequency, DayOfWeek } from "../../generated/tenant-client";

const TODAY = new Date("2026-11-03T00:00:00.000Z"); // Tuesday
const THU = new Date("2026-11-05T00:00:00.000Z");
const FRI = new Date("2026-11-06T00:00:00.000Z");

const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Jane ${id}`, phone: "07", email: null, ghlContactId: `g-${id}`, messagesOptOut: false, ...over,
});
const visit = (id: string, cust = customer("c1"), plan: unknown = null) => ({
  id,
  servicePlan: plan,
  technician: { name: "Tom" },
  property: { addressLine: `${id} High St`, customer: cust },
});

function makePrisma(visits: unknown[], round: unknown = { name: "Alnwick Fri", frequency: CleaningFrequency.FOUR_WEEKLY, defaultDay: DayOfWeek.THU }) {
  const tx = {
    visit: { updateMany: vi.fn().mockImplementation(async ({ where }) => ({ count: where.id.in.length })) },
    servicePlan: { update: vi.fn().mockResolvedValue({}) },
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    integrationOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const prisma = {
    round: { findUnique: vi.fn().mockResolvedValue(round) },
    visit: { findMany: vi.fn().mockResolvedValue(visits) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ businessName: "Shine Ltd" }) },
    messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma: prisma as unknown as Parameters<typeof createWeatherHoldService>[0], raw: prisma, tx };
}

const input = { date: THU, condition: "heavy-rain" as const, rescheduling: "next-available" as const };
const BROADCAST = { queued: 1, sent: 1, scheduled: 0, skippedOptedOut: 0, skippedNoContact: 0, failed: 0, scheduledFor: null, recipients: [] };

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(TODAY);
  tenantWorkingDays.mockResolvedValue([]);
  tenantTodayRange.mockResolvedValue({ start: TODAY, end: new Date(TODAY.getTime() + 86_400_000) });
  getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: null });
  assertAnyChannelAvailable.mockResolvedValue(undefined);
  broadcast.mockResolvedValue(BROADCAST);
});

describe("preview", () => {
  it("counts visits/customers and renders the message for the first customer (next working day)", async () => {
    const { prisma, raw } = makePrisma([visit("v1"), visit("v2"), visit("v3", customer("c2", { messagesOptOut: true }))]);
    const p = await createWeatherHoldService(prisma).preview("r1", input);
    expect(p).toMatchObject({
      date: "2026-11-05", affectedVisits: 3, affectedCustomers: 2, optedOutCustomers: 1, newDate: "2026-11-06", templateName: null,
    });
    expect(p.message).toBe(
      "Hi Jane, due to heavy rain we've had to postpone your window clean at v1 High St. Your new date is Friday 6 November. Thanks for understanding, Shine Ltd."
    );
    expect(p.characterCount).toBe(p.message.length);
    expect(raw.visit.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { roundId: "r1", status: "SCHEDULED", date: { gte: THU, lt: FRI } },
    }));
  });

  it("uses the tenant 'Weather Hold' template when present, and the no-date wording for manual", async () => {
    const { prisma, raw } = makePrisma([visit("v1")]);
    raw.messageTemplate.findFirst.mockResolvedValue({ id: "t1", body: "Weather: {{condition}} / {{newDate}} / {{date}} / {{technicianName}}" });
    const withTemplate = await createWeatherHoldService(prisma).preview("r1", { ...input, condition: "technician-safety" });
    expect(withTemplate.message).toBe("Weather: safety concerns for our team / Friday 6 November / Thursday 5 November / Tom");
    expect(withTemplate.templateName).toBe("Weather Hold");

    raw.messageTemplate.findFirst.mockResolvedValue(null);
    const manual = await createWeatherHoldService(prisma).preview("r1", { ...input, rescheduling: "manual" });
    expect(manual.newDate).toBeNull();
    expect(manual.message).toContain("We'll be in touch shortly with a new date.");
  });

  it("returns an empty preview when nothing is scheduled", async () => {
    const { prisma } = makePrisma([]);
    expect(await createWeatherHoldService(prisma).preview("r1", input)).toMatchObject({
      affectedVisits: 0, affectedCustomers: 0, newDate: null, message: "", characterCount: 0,
    });
  });

  it("rejects an unknown round and a past date", async () => {
    const missing = makePrisma([], null);
    await expect(createWeatherHoldService(missing.prisma).preview("nope", input)).rejects.toMatchObject({ statusCode: 404 });
    const { prisma } = makePrisma([]);
    await expect(createWeatherHoldService(prisma).preview("r1", { ...input, date: new Date("2026-11-02T00:00:00.000Z") }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("tells a customer with several held visits about the earliest new date", async () => {
    const plan = (freq: CleaningFrequency | null) => ({ id: "sp", cleaningFrequency: freq, nextDueDate: null });
    const { prisma } = makePrisma(
      [visit("v1", customer("c1"), plan(CleaningFrequency.EIGHT_WEEKLY)), visit("v2", customer("c1"), plan(CleaningFrequency.FOUR_WEEKLY))],
    );
    const p = await createWeatherHoldService(prisma).preview("r1", { ...input, rescheduling: "next-cycle" });
    expect(p.newDate).toBe("2026-12-03");
    expect(p.affectedCustomers).toBe(1);
    expect(p.message).toContain("Thursday 3 December");
  });
});

describe("apply: technician notifications (FLOW-03)", () => {
  const techVisit = (id: string, technicianId: string | null) => ({ ...visit(id), technicianId, roundId: "r1" });

  it("tells the technicians on the held visits, independent of notifyCustomers", async () => {
    const { prisma } = makePrisma([techVisit("v1", "t1"), techVisit("v2", "t1"), techVisit("v3", null)]);
    await createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: false });

    const call = vi.mocked(notifyVisitTechnicians).mock.calls[0];
    expect(call[1]).toEqual([
      { id: "v1", technicianId: "t1", roundId: "r1", date: THU },
      { id: "v2", technicianId: "t1", roundId: "r1", date: THU },
      { id: "v3", technicianId: null, roundId: "r1", date: THU },
    ]);
    expect(call[2]({ count: 2, first: "2026-11-05" })).toEqual({
      type: "SCHEDULE",
      title: "Weather hold: 2 visits postponed",
      body: "Heavy rain on 2026-11-05. Moved to 2026-11-06.",
    });
  });

  it("manual holds tell the technician the office will rebook", async () => {
    const { prisma } = makePrisma([techVisit("v1", "t1")]);
    await createWeatherHoldService(prisma).apply("r1", { ...input, rescheduling: "manual", notifyCustomers: false });
    const wording = vi.mocked(notifyVisitTechnicians).mock.calls[0][2]({ count: 1, first: "2026-11-05" });
    expect(wording).toEqual({
      type: "SCHEDULE",
      title: "Weather hold: 1 visit postponed",
      body: "Heavy rain on 2026-11-05. The office will rebook these visits.",
    });
  });
});

describe("apply", () => {
  it("next-available: moves visits to the next working day, clears reminder markers, logs the hold and notifies", async () => {
    const { prisma, tx } = makePrisma([visit("v1"), visit("v2", customer("c2"))]);
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: true, actor: { id: "u1", role: "ADMIN" } });

    expect(tx.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, status: "SCHEDULED" },
      data: { date: FRI, reminderSentAt: null, reminderSentTypes: [] },
    });
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "WEATHER_HOLD", actorId: "u1", actorRole: "ADMIN", entityId: "r1",
        details: expect.objectContaining({ date: "2026-11-05", condition: "heavy-rain", rescheduling: "next-available", newDate: "2026-11-06", visitIds: ["v1", "v2"] }),
      }),
    });
    expect(assertAnyChannelAvailable).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [targets, opts] = broadcast.mock.calls[0];
    expect(targets.map((t: { customer: { id: string } }) => t.customer.id)).toEqual(["c1", "c2"]);
    expect(opts).toMatchObject({ templateId: null, reason: "WEATHER_HOLD", extraPayload: { roundId: "r1" } });
    expect(res).toEqual({
      roundId: "r1", date: "2026-11-05", condition: "heavy-rain", rescheduling: "next-available",
      held: 2, newDate: "2026-11-06", notification: BROADCAST,
    });
  });

  it("skips Saturday and Sunday when moving to the next working day", async () => {
    const { prisma, tx } = makePrisma([visit("v1")]);
    await createWeatherHoldService(prisma).apply("r1", { ...input, date: FRI, notifyCustomers: false });
    expect(tx.visit.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ date: new Date("2026-11-09T00:00:00.000Z") }),
    }));
  });

  it("honours the business working days: a Mon-Sat business moves Friday visits to Saturday", async () => {
    tenantWorkingDays.mockResolvedValue(["MON", "TUE", "WED", "THU", "FRI", "SAT"]);
    const { prisma, tx } = makePrisma([visit("v1")]);
    await createWeatherHoldService(prisma).apply("r1", { ...input, date: FRI, notifyCustomers: false });
    expect(tx.visit.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ date: new Date("2026-11-07T00:00:00.000Z") }),
    }));
  });

  it("does not notify, nor require GHL, when notifyCustomers is false", async () => {
    const { prisma } = makePrisma([visit("v1")]);
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: false });
    expect(assertAnyChannelAvailable).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(res.notification).toBeNull();
    expect(res.held).toBe(1);
  });

  it("changes nothing when GHL is required but not connected", async () => {
    assertAnyChannelAvailable.mockRejectedValue(Object.assign(new Error("GoHighLevel is not connected"), { statusCode: 409 }));
    const { prisma, raw } = makePrisma([visit("v1")]);
    await expect(createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it("next-cycle: moves each visit a cycle on and advances the plan's nextDueDate once", async () => {
    const plan = { id: "sp1", cleaningFrequency: CleaningFrequency.FOUR_WEEKLY, nextDueDate: new Date("2026-12-03T00:00:00.000Z") };
    const later = { id: "sp2", cleaningFrequency: CleaningFrequency.FOUR_WEEKLY, nextDueDate: new Date("2026-12-31T00:00:00.000Z") };
    const { prisma, tx } = makePrisma([
      visit("v1", customer("c1"), plan), visit("v2", customer("c2"), plan), visit("v3", customer("c3"), later), visit("v4", customer("c4"), null),
    ]);
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, rescheduling: "next-cycle", notifyCustomers: false });

    // v1-v3: 4 weeks on (Thu 3 Dec); v4 has no plan, so the round frequency (also 4 weekly) applies.
    expect(tx.visit.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.visit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["v1", "v2", "v3", "v4"] }, status: "SCHEDULED" } }));
    expect(tx.servicePlan.update).toHaveBeenCalledTimes(1); // sp1 bumped once; sp2 is already beyond the new date
    expect(tx.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { nextDueDate: new Date("2026-12-31T00:00:00.000Z") } });
    expect(res.newDate).toBe("2026-12-03");
  });

  it("next-cycle: a visit with no frequency falls back to the next working day and bumps no plan", async () => {
    const plan = { id: "sp1", cleaningFrequency: null, nextDueDate: new Date("2026-11-06T00:00:00.000Z") };
    const { prisma, tx } = makePrisma([visit("v1", customer("c1"), plan)], { name: "R", frequency: null, defaultDay: null });
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, rescheduling: "next-cycle", notifyCustomers: false });
    expect(res.newDate).toBe("2026-11-06");
    expect(tx.servicePlan.update).not.toHaveBeenCalled();
  });

  it("manual: marks visits SKIPPED with the weather reason and gives no new date", async () => {
    const { prisma, tx } = makePrisma([visit("v1"), visit("v2")]);
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, condition: "snow-ice", rescheduling: "manual", notifyCustomers: true });
    expect(tx.visit.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["v1", "v2"] }, status: "SCHEDULED" },
      data: { status: "SKIPPED", skipReason: `Weather hold: ${WEATHER_CONDITIONS["snow-ice"].label}` },
    });
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null, actorRole: null, message: expect.stringContaining("reschedule manually") }),
    });
    expect(res.newDate).toBeNull();
    expect(res.held).toBe(2);
  });

  it("cancels reminders still queued for the held visits so they cannot send the old date", async () => {
    const { prisma, tx } = makePrisma([visit("v1"), visit("v2", customer("c2"))]);
    await createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: false });
    expect(tx.integrationOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        status: "pending",
        eventType: "message.send",
        OR: [{ payload: { path: ["visitId"], equals: "v1" } }, { payload: { path: ["visitId"], equals: "v2" } }],
      },
      data: { status: "cancelled", lastError: "Weather hold", processedAt: expect.any(Date) },
    });
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ details: expect.objectContaining({ cancelledReminders: 2 }) }),
    });
  });

  it("manual hold: a tenant template that promises {{newDate}} is replaced by the no-date wording", async () => {
    const { prisma, raw } = makePrisma([visit("v1")]);
    raw.messageTemplate.findFirst.mockResolvedValue({ id: "t1", body: "Moved to {{newDate}} because of {{condition}}" });
    const manual = await createWeatherHoldService(prisma).preview("r1", { ...input, rescheduling: "manual" });
    expect(manual.templateName).toBeNull();
    expect(manual.message).toContain("due to heavy rain");
    expect(manual.message).toContain("be in touch shortly with a new date.");
    expect(manual.message).not.toContain("to be confirmed");

    // A tenant template without a date promise is still honoured for manual holds.
    raw.messageTemplate.findFirst.mockResolvedValue({ id: "t2", body: "Sorry, {{condition}} - we will call." });
    const own = await createWeatherHoldService(prisma).preview("r1", { ...input, rescheduling: "manual" });
    expect(own).toMatchObject({ message: "Sorry, heavy rain - we will call.", templateName: "Weather Hold" });
  });

  it("409s with nothing to hold, and when today's operational day is closed", async () => {
    const empty = makePrisma([]);
    await expect(createWeatherHoldService(empty.prisma).apply("r1", { ...input, notifyCustomers: false }))
      .rejects.toMatchObject({ statusCode: 409, code: "NO_VISITS_TO_HOLD" });

    getCachedBusinessSettings.mockResolvedValue({ lastClosedDate: "2026-11-03" });
    const { prisma, raw } = makePrisma([visit("v1")]);
    await expect(createWeatherHoldService(prisma).apply("r1", { ...input, date: TODAY, notifyCustomers: false }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("already been closed") });
    expect(raw.$transaction).not.toHaveBeenCalled();

    // A later date is not affected by today's Close Day.
    await expect(createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: false })).resolves.toMatchObject({ held: 1 });
  });

  it("keeps the hold and reports notificationError when the notification step itself fails", async () => {
    broadcast.mockRejectedValue(new Error("ghl down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { prisma } = makePrisma([visit("v1")]);
    const res = await createWeatherHoldService(prisma).apply("r1", { ...input, notifyCustomers: true });
    expect(res).toMatchObject({ held: 1, notification: null, notificationError: "ghl down" });
    err.mockRestore();
  });
});
