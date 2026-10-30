import { it, expect, vi, beforeEach, afterEach, describe } from "vitest";
import { createSetupService, WIZARD_STEPS } from "../setup.service";

// Phase 1 audit remediation: completedSteps (GAP-002), address/VAT (B1),
// reminders (B2), payment defaults (GAP-008), customer matching (GAP-010),
// bulk validation (GAP-009), nextDueDate + activation (A2 / X-1 / X-2).

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
type Fn = ReturnType<typeof vi.fn>;

function makePrisma() {
  const p = {
    businessSettings: {
      findFirst: vi.fn().mockResolvedValue({ completedSteps: [], setupCompleted: false }),
      upsert: vi.fn((args: { update: Record<string, unknown> }) => Promise.resolve({ ...args.update })),
    },
    service: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    serviceArea: {
      findMany: vi.fn().mockResolvedValue([{ id: "area1" }]),
      findUnique: vi.fn().mockResolvedValue({ id: "area1" }),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    technician: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
    technicianServiceArea: { createMany: vi.fn() },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    round: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue({ id: "round1", status: "ACTIVE", frequency: "FOUR_WEEKLY", defaultDay: "FRI" }),
      create: vi.fn().mockResolvedValue({ id: "new-round" }),
      update: vi.fn().mockResolvedValue({ id: "existing-round" }),
      count: vi.fn().mockResolvedValue(0),
    },
    roundTechnician: { deleteMany: vi.fn(), createMany: vi.fn() },
    customer: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "new-cust", ...args.data })),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    property: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn().mockResolvedValue({ id: "prop1" }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    servicePlan: {
      findMany: vi.fn((args: any) => Promise.resolve((args?.where?.id?.in ?? []).map((id: string) => ({ id })))),
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "sp1", ...args.data })),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    visit: { createMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    bulkImportAttempt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  p.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p)));
  return p;
}
const svcFor = (p: ReturnType<typeof makePrisma>) => createSetupService(p as never);
const lastUpsert = (p: ReturnType<typeof makePrisma>) => (p.businessSettings.upsert as Fn).mock.calls.at(-1)![0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z")); // a Wednesday
});
afterEach(() => {
  vi.useRealTimers();
});

describe("completedSteps / getStatus (GAP-002)", () => {
  it("steps come from completedSteps, not row counts, and wizardSteps follow the web's order", async () => {
    const p = makePrisma();
    p.businessSettings.findFirst.mockResolvedValue({ completedSteps: [1, 7, 4, 3], setupCompleted: false });
    const status = await svcFor(p).getStatus();

    expect(status.steps.filter((s) => s.complete).map((s) => s.step)).toEqual([1, 3, 4, 7]);
    expect(status.wizardSteps.map((w) => w.key)).toEqual(WIZARD_STEPS.map((w) => w.key));
    expect(status.wizardSteps.slice(0, 3)).toEqual([
      { key: "business-profile", step: 1, complete: true },
      { key: "service-area", step: 7, complete: true },
      { key: "round-settings", step: 4, complete: true },
    ]);
    expect(status.allRequiredComplete).toBe(false);
    expect(p.service.findMany).not.toHaveBeenCalled();
  });

  it("all required steps saved → allRequiredComplete; step 10 via completedSteps", async () => {
    const p = makePrisma();
    p.businessSettings.findFirst.mockResolvedValue({ completedSteps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], setupCompleted: false });
    const status = await svcFor(p).getStatus();
    expect(status.allRequiredComplete).toBe(true);
    expect(status.steps.find((s) => s.step === 10)?.complete).toBe(true);
  });

  it("markStepComplete appends once, sorted, and is a no-op when already saved", async () => {
    const p = makePrisma();
    p.businessSettings.findFirst.mockResolvedValue({ completedSteps: [3, 9] });
    await svcFor(p).markStepComplete(5);
    expect(lastUpsert(p).update).toEqual({ completedSteps: [3, 5, 9] });

    const p2 = makePrisma();
    p2.businessSettings.findFirst.mockResolvedValue({ completedSteps: [5] });
    await svcFor(p2).markStepComplete(5);
    expect(p2.businessSettings.upsert).not.toHaveBeenCalled();
  });

  it("saving a step that is already recorded keeps completedSteps unchanged", async () => {
    const p = makePrisma();
    p.businessSettings.findFirst.mockResolvedValue({ completedSteps: [1, 2] });
    await svcFor(p).saveBusinessProfile({ businessName: "X" });
    expect(lastUpsert(p).update.completedSteps).toEqual([1, 2]);
  });

  it("each wizard save records its step", async () => {
    const p = makePrisma();
    p.businessSettings.findFirst.mockResolvedValue(null);
    const svc = svcFor(p);
    await svc.saveServices([]);
    expect(lastUpsert(p).update.completedSteps).toEqual([3]);

    const p6 = makePrisma();
    await svcFor(p6).saveTechnicians([]);
    expect(lastUpsert(p6).update.completedSteps).toEqual([6]);

    const p7 = makePrisma();
    p7.serviceArea.findMany.mockResolvedValue([]);
    await svcFor(p7).saveServiceAreas([{ name: "Alnwick" }]);
    expect(lastUpsert(p7).update.completedSteps).toEqual([7]);

    const p10 = makePrisma();
    await svcFor(p10).assignTechniciansToRounds([]);
    expect(lastUpsert(p10).update.completedSteps).toEqual([10]);
  });

  it("saveFirstRound records step 8 on both the create and the update path", async () => {
    const p = makePrisma();
    await expect(svcFor(p).saveFirstRound({ name: "R" })).resolves.toEqual({ id: "new-round" });
    expect(lastUpsert(p).update.completedSteps).toEqual([8]);

    const p2 = makePrisma();
    p2.round.findFirst.mockResolvedValue({ id: "existing-round" });
    await expect(svcFor(p2).saveFirstRound({ name: "R" })).resolves.toEqual({ id: "existing-round" });
    expect(p2.round.update).toHaveBeenCalled();
  });
});

describe("settings steps 1 and 4 (B1, B2)", () => {
  it("saveBusinessProfile writes address, town, postcode and vatRate", async () => {
    const p = makePrisma();
    await svcFor(p).saveBusinessProfile({
      businessName: "Coates", addressLine1: "1 Audit St", addressLine2: null, town: "Alnwick", postcode: "NE66 1TD", vatRate: 5,
    });
    expect(lastUpsert(p).update).toMatchObject({
      addressLine1: "1 Audit St", addressLine2: null, town: "Alnwick", postcode: "NE66 1TD", vatRate: 5, completedSteps: [1],
    });
  });

  it("saveRoundSettings writes the reminder, clean-method and auto-next-visit fields", async () => {
    const p = makePrisma();
    await svcFor(p).saveRoundSettings({
      defaultCycleLength: 28, reminderMode: "MORNING_OF", reminderTime: "07:30", defaultCleanMethod: "BOTH", autoCreateNextVisit: false,
    });
    expect(lastUpsert(p).update).toMatchObject({
      defaultCycleLength: 28, reminderMode: "MORNING_OF", reminderTime: "07:30", defaultCleanMethod: "BOTH", autoCreateNextVisit: false, completedSteps: [4],
    });
  });
});

const baseInput = {
  customerName: "Jo Bloggs",
  fullAddress: "1 High St",
  postcode: "NE66 1AA",
  serviceAreaId: "area1",
  roundId: "round1",
  price: 20,
};

describe("addSetupProperty (A2, GAP-010)", () => {
  it("creates a new customer when nothing matches; frequency defaults to the round's; nextDueDate is the round's next day", async () => {
    const p = makePrisma();
    p.customer.findMany.mockResolvedValue([{ id: "other", phone: "07000000000", email: null }]);
    const result = await svcFor(p).addSetupProperty({ ...baseInput, phone: "07700900201" });

    expect(result.customerMatched).toBe(false);
    expect(p.customer.create).toHaveBeenCalled();
    expect(p.servicePlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-10-30") }),
    });
    expect(lastUpsert(p).update.completedSteps).toEqual([9]);
  });

  it("reuses a customer matched by mobile (UK forms are equivalent)", async () => {
    const p = makePrisma();
    p.customer.findMany.mockResolvedValue([{ id: "c1", phone: "+44 7700 900201", email: null }]);
    p.customer.findUnique.mockResolvedValue({ id: "c1", name: "Jo" });
    const result = await svcFor(p).addSetupProperty({ ...baseInput, phone: "07700 900201" });

    expect(result.customerMatched).toBe(true);
    expect(result.customer).toEqual({ id: "c1", name: "Jo" });
    expect(p.customer.create).not.toHaveBeenCalled();
    expect(p.property.create).toHaveBeenCalledWith({ data: expect.objectContaining({ customerId: "c1" }) });
  });

  it("reuses an explicit customerId, and 404s when it doesn't exist", async () => {
    const p = makePrisma();
    p.customer.findUnique.mockResolvedValue({ id: "c9" });
    await expect(svcFor(p).addSetupProperty({ ...baseInput, customerId: "c9" })).resolves.toMatchObject({ customerMatched: true });
    expect(p.customer.findMany).not.toHaveBeenCalled();

    const p2 = makePrisma();
    await expect(svcFor(p2).addSetupProperty({ ...baseInput, customerId: "nope" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("skips matching when the row has no phone or email", async () => {
    const p = makePrisma();
    await svcFor(p).addSetupProperty({ ...baseInput, email: "jo@x.com" });
    expect(p.customer.findMany).toHaveBeenCalledTimes(1);

    const p2 = makePrisma();
    await svcFor(p2).addSetupProperty(baseInput);
    expect(p2.customer.findMany).not.toHaveBeenCalled();
  });

  it("nextDueDate from lastCleanedDate; with no frequency anywhere uses the round day or today", async () => {
    const p = makePrisma();
    await svcFor(p).addSetupProperty({ ...baseInput, cleaningFrequency: "FOUR_WEEKLY", lastCleanedDate: "2026-10-16" });
    expect((p.servicePlan.create as Fn).mock.calls[0][0].data.nextDueDate).toEqual(d("2026-11-13"));

    const p2 = makePrisma();
    p2.round.findUnique.mockResolvedValue({ id: "round1", status: "ACTIVE", frequency: null, defaultDay: "MON" });
    await svcFor(p2).addSetupProperty(baseInput);
    expect((p2.servicePlan.create as Fn).mock.calls[0][0].data).toMatchObject({ cleaningFrequency: null, nextDueDate: d("2026-11-02") });

    const p3 = makePrisma();
    p3.round.findUnique.mockResolvedValue({ id: "round1", status: "ACTIVE", frequency: null, defaultDay: null });
    await svcFor(p3).addSetupProperty(baseInput);
    expect((p3.servicePlan.create as Fn).mock.calls[0][0].data.nextDueDate).toEqual(d("2026-10-28"));
  });

  it("400s on an invalid lastCleanedDate", async () => {
    const p = makePrisma();
    await expect(svcFor(p).addSetupProperty({ ...baseInput, lastCleanedDate: "not-a-date" })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("bulkAddSetupProperties (GAP-009, GAP-010, A2)", () => {
  const row = (over: Record<string, unknown> = {}) => ({ ...baseInput, phone: "07700900201", ...over });

  beforeEach(() => undefined);

  function bulkPrisma(rounds = [{ id: "round1", status: "ACTIVE", frequency: "FOUR_WEEKLY", defaultDay: "FRI" }]) {
    const p = makePrisma();
    p.round.findMany.mockResolvedValue(rounds);
    p.customer.findMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id?.in ? args.where.id.in.map((id: string) => ({ id })) : [])
    );
    return p;
  }

  it("rejects a frequency that differs from the round's unless allowFrequencyMismatch", async () => {
    const p = bulkPrisma();
    const res = await svcFor(p).bulkAddSetupProperties([row({ cleaningFrequency: "SIX_WEEKLY" }), row({ phone: "07000000001" })]);
    expect(res.created).toBe(1);
    expect(res.errors).toEqual([expect.objectContaining({ row: 0, field: "cleaningFrequency", error: expect.stringContaining("allowFrequencyMismatch") })]);
    const plans = (p.servicePlan.createMany as Fn).mock.calls[0][0].data;
    expect(plans[0]).toMatchObject({ cleaningFrequency: "FOUR_WEEKLY", nextDueDate: d("2026-10-30") });

    const p2 = bulkPrisma();
    const ok = await svcFor(p2).bulkAddSetupProperties([row({ cleaningFrequency: "SIX_WEEKLY" })], undefined, { allowFrequencyMismatch: true });
    expect(ok.created).toBe(1);
    expect((p2.servicePlan.createMany as Fn).mock.calls[0][0].data[0].cleaningFrequency).toBe("SIX_WEEKLY");
  });

  it("a round without a frequency accepts any row frequency", async () => {
    const p = bulkPrisma([{ id: "round1", status: "ACTIVE", frequency: null, defaultDay: null } as never]);
    const res = await svcFor(p).bulkAddSetupProperties([row({ cleaningFrequency: "SIX_WEEKLY" }), row({ phone: "07000000002" })]);
    expect(res.created).toBe(2);
    expect((p.servicePlan.createMany as Fn).mock.calls[0][0].data[1]).toMatchObject({ cleaningFrequency: null, nextDueDate: d("2026-10-28") });
  });

  it("rows sharing a mobile/email share one customer; existing customers are reused; customerMatched is per row", async () => {
    const p = bulkPrisma();
    p.customer.findMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id?.in ? args.where.id.in.map((id: string) => ({ id })) : [{ id: "old", phone: null, email: "OLD@x.com" }])
    );
    const res = await svcFor(p).bulkAddSetupProperties([
      row({ phone: "07700900201" }),
      row({ phone: "+44 7700 900201" }),
      row({ phone: "07000000003", email: "old@x.com" }),
    ]);
    expect(res.results.map((r) => r.customerMatched)).toEqual([false, true, true]);
    const created = (p.customer.createMany as Fn).mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    const props = (p.property.createMany as Fn).mock.calls[0][0].data;
    expect(props[0].customerId).toBe(props[1].customerId);
    expect(props[2].customerId).toBe("old");
  });

  it("customerId rows must reference an existing customer (per-row error)", async () => {
    const p = bulkPrisma();
    p.customer.findMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.id?.in ? args.where.id.in.filter((id: string) => id === "c1").map((id: string) => ({ id })) : [])
    );
    const res = await svcFor(p).bulkAddSetupProperties([row({ customerId: "c1" }), row({ customerId: "ghost" })]);
    expect(res.created).toBe(1);
    expect(res.results[0].customerMatched).toBe(true);
    expect(res.errors).toEqual([expect.objectContaining({ row: 1, field: "customerId" })]);
    expect((p.customer.createMany as Fn).mock.calls[0][0].data).toEqual([]);
  });

  it("an invalid lastCleanedDate is a row error; a valid one sets nextDueDate", async () => {
    const p = bulkPrisma();
    const res = await svcFor(p).bulkAddSetupProperties([row({ lastCleanedDate: "nope" }), row({ lastCleanedDate: "2026-10-16" })]);
    expect(res.errors).toEqual([expect.objectContaining({ row: 0, field: "lastCleanedDate" })]);
    expect((p.servicePlan.createMany as Fn).mock.calls[0][0].data[0].nextDueDate).toEqual(d("2026-11-13"));
  });

  it("customers from a failed batch are not reused by later batches", async () => {
    const p = bulkPrisma();
    let call = 0;
    p.$transaction.mockImplementation((arg: any) => (call++ === 0 ? Promise.reject(new Error("boom")) : Promise.all(arg)));
    const rows = Array.from({ length: 101 }, (_, i) => row({ phone: `0770090${String(i).padStart(4, "0")}` }));
    rows[100] = row({ phone: rows[0].phone });
    const res = await svcFor(p).bulkAddSetupProperties(rows);
    expect(res.created).toBe(1);
    expect(res.results[0].customerMatched).toBe(false);
    expect((p.customer.createMany as Fn).mock.calls[1][0].data).toHaveLength(1);
  });

  it("a non-Error batch failure is reported with its string form", async () => {
    const p = bulkPrisma();
    p.$transaction.mockImplementation(() => Promise.reject("db gone"));
    const res = await svcFor(p).bulkAddSetupProperties([row()]);
    expect(res.errors).toEqual([expect.objectContaining({ field: "batch", error: "db gone" })]);
  });

  it("all rows failing validation skips the customer lookup and step marking", async () => {
    const p = bulkPrisma();
    const res = await svcFor(p).bulkAddSetupProperties([row({ price: -1 })]);
    expect(res.created).toBe(0);
    expect(p.customer.findMany).not.toHaveBeenCalled();
    expect(p.businessSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("activation (A2, X-1, X-2, GAP-016)", () => {
  function activationPrisma() {
    const p = makePrisma();
    p.round.findMany.mockResolvedValue([
      {
        id: "r1",
        name: "Alnwick Fri",
        defaultDay: "FRI",
        frequency: "FOUR_WEEKLY",
        roundTechnicians: [{ technicianId: "t1" }],
        properties: [
          {
            id: "p1",
            assignedTechnicianId: null,
            customer: { holdNextClean: true },
            servicePlans: [{ id: "sp1", price: 20, paymentMethod: null, cleaningFrequency: null }],
          },
        ],
      },
    ]);
    return p;
  }

  it("creates visits (exclusive end) with technician + hold, continues each plan's nextDueDate, and records step 11", async () => {
    const p = activationPrisma();
    const res = await svcFor(p).activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 8 });
    expect(res).toEqual({ visitsGenerated: 2 });

    const visits = (p.visit.createMany as Fn).mock.calls[0][0].data;
    expect(visits.map((v: any) => [v.date, v.technicianId, v.paymentHold])).toEqual([
      [d("2026-10-30"), "t1", true],
      [d("2026-11-27"), "t1", false],
    ]);
    expect(p.servicePlan.update).toHaveBeenCalledWith({ where: { id: "sp1" }, data: { nextDueDate: d("2026-12-25") } });
    expect(lastUpsert(p).update.completedSteps).toEqual([11]);
    expect(p.round.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE" } }));
  });

  it("targets the given roundIds; writes nothing (and doesn't record step 11) when there are no visits", async () => {
    const p = makePrisma();
    p.round.findMany.mockResolvedValue([{ id: "r1", name: "R", defaultDay: null, frequency: null, roundTechnicians: [], properties: [] }]);
    const res = await svcFor(p).activateSystem({ generateAll: false, roundIds: ["r1"], startDate: "2026-10-28", cycleWeeks: 4 });
    expect(res).toEqual({ visitsGenerated: 0 });
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(p.businessSettings.upsert).not.toHaveBeenCalled();
    expect(p.round.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE", id: { in: ["r1"] } } }));
  });

  it("validates the window and guards", async () => {
    const svc = svcFor(makePrisma());
    await expect(svc.activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 0 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 53 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 1.5 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: true, startDate: "garbage", cycleWeeks: 4 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: true, startDate: "2026-10-27", cycleWeeks: 4 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: false, startDate: "2026-10-30", cycleWeeks: 4 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.activateSystem({ generateAll: false, roundIds: ["x"], startDate: "2026-10-30", cycleWeeks: 4 })).rejects.toMatchObject({ statusCode: 404 });

    const done = makePrisma();
    done.businessSettings.findFirst.mockResolvedValue({ setupCompleted: true });
    await expect(svcFor(done).activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 4 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("previewActivation counts exactly what activation creates", async () => {
    const p = activationPrisma();
    p.round.findMany.mockResolvedValue([
      ...(await activationPrisma().round.findMany()),
      { id: "r2", name: "Empty", defaultDay: null, frequency: null, roundTechnicians: [], properties: [] },
    ]);
    const preview = await svcFor(p).previewActivation({ startDate: "2026-10-30", cycleWeeks: 8 });
    expect(preview).toEqual({
      rounds: [
        { roundId: "r1", name: "Alnwick Fri", firstVisit: "2026-10-30", visits: 2 },
        { roundId: "r2", name: "Empty", firstVisit: null, visits: 0 },
      ],
      total: 2,
    });
    const created = await svcFor(p).activateSystem({ generateAll: true, startDate: "2026-10-30", cycleWeeks: 8 });
    expect(created.visitsGenerated).toBe(preview.total);
  });
});
