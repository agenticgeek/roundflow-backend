import { it, expect, vi, describe, beforeEach } from "vitest";

const tenantToday = vi.fn();
vi.mock("../business-time", () => ({ tenantToday: (...a: unknown[]) => tenantToday(...a) }));

import { createRoundDeleteService } from "../round-delete.service";

const TODAY = new Date("2026-11-25T00:00:00.000Z");
const YESTERDAY = new Date("2026-11-24T00:00:00.000Z");
const TOMORROW = new Date("2026-11-26T00:00:00.000Z");

// --- tiny in-memory tenant DB: only the queries the round delete uses -------------------------------
interface FakeVisit {
  id: string;
  roundId: string | null;
  status: string;
  date: Date;
  invoice?: boolean;
  invoiceLine?: boolean;
  payment?: boolean;
  photos?: number;
  issues?: number;
  incidents?: number;
}
interface State {
  rounds: { id: string; name: string }[];
  properties: { id: string; roundId: string | null; assignedTechnicianId: string | null }[];
  visits: FakeVisit[];
  emergencies: { id: string; roundId: string }[];
  chatMessages: { id: string; roundId: string; visitId: string | null }[];
  chatReads: { profileId: string; roundId: string }[];
  outbox: { id: string; status: string; eventType: string; payload: { visitId?: string } }[];
}

type Where = Record<string, any>;
const matchVisit = (v: FakeVisit, w: Where) =>
  (w.roundId === undefined || v.roundId === w.roundId) &&
  (w.status?.in === undefined || w.status.in.includes(v.status)) &&
  (w.date?.gte === undefined || v.date.getTime() >= w.date.gte.getTime()) &&
  (w.id?.in === undefined || w.id.in.includes(v.id));

function makeDb(s: State) {
  return {
    round: {
      findUnique: vi.fn(async ({ where }: any) => s.rounds.find((r) => r.id === where.id) ?? null),
      delete: vi.fn(async ({ where }: any) => {
        const i = s.rounds.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("not found");
        const [r] = s.rounds.splice(i, 1);
        // DB cascades: RoundTechnician + ChatMessage rows of the round.
        s.chatMessages = s.chatMessages.filter((m) => m.roundId !== where.id);
        return r;
      }),
    },
    property: {
      count: vi.fn(async ({ where }: any) => s.properties.filter((p) => p.roundId === where.roundId).length),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = s.properties.filter((p) => p.roundId === where.roundId);
        hit.forEach((p) => Object.assign(p, data));
        return { count: hit.length };
      }),
    },
    technicianEmergency: {
      count: vi.fn(async ({ where }: any) => s.emergencies.filter((e) => e.roundId === where.roundId).length),
    },
    visit: {
      count: vi.fn(async ({ where }: any) => s.visits.filter((v) => matchVisit(v, where)).length),
      findMany: vi.fn(async ({ where }: any) =>
        s.visits.filter((v) => matchVisit(v, where)).map((v) => ({
          id: v.id,
          invoice: v.invoice ? { id: `inv-${v.id}` } : null,
          invoiceLine: v.invoiceLine ? { id: `il-${v.id}` } : null,
          payment: v.payment ? { id: `pay-${v.id}` } : null,
          _count: { photos: v.photos ?? 0, issues: v.issues ?? 0, incidents: v.incidents ?? 0 },
        }))
      ),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = s.visits.length;
        s.visits = s.visits.filter((v) => !matchVisit(v, where));
        return { count: before - s.visits.length };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = s.visits.filter((v) => matchVisit(v, where));
        hit.forEach((v) => Object.assign(v, data));
        return { count: hit.length };
      }),
    },
    chatMessage: {
      findMany: vi.fn(async ({ where }: any) => {
        const ids = new Set(s.chatMessages.filter((m) => m.visitId && where.visitId.in.includes(m.visitId)).map((m) => m.visitId));
        return [...ids].map((visitId) => ({ visitId }));
      }),
    },
    chatRead: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = s.chatReads.length;
        s.chatReads = s.chatReads.filter((r) => r.roundId !== where.roundId);
        return { count: before - s.chatReads.length };
      }),
    },
    integrationOutbox: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const ids: string[] = where.OR.map((o: any) => o.payload.equals);
        const hit = s.outbox.filter((m) => m.status === where.status && m.eventType === where.eventType && ids.includes(m.payload.visitId!));
        hit.forEach((m) => Object.assign(m, data));
        return { count: hit.length };
      }),
    },
  };
}
type Db = ReturnType<typeof makeDb>;

// `txOnly`: the outer client has nothing but $transaction, so every read/write must go through the tx.
function makePrisma(db: Db, opts: { txOnly?: boolean; beforeTx?: () => void } = {}) {
  const $transaction = vi.fn(async (fn: (tx: Db) => unknown) => {
    opts.beforeTx?.();
    return fn(db);
  });
  const prisma = opts.txOnly ? { $transaction } : { ...db, $transaction };
  return prisma as unknown as Parameters<typeof createRoundDeleteService>[0];
}

function baseState(): State {
  return {
    rounds: [{ id: "r1", name: "Monday North" }, { id: "r2", name: "Other" }],
    properties: [
      { id: "p1", roundId: "r1", assignedTechnicianId: "t1" },
      { id: "p2", roundId: "r1", assignedTechnicianId: null },
      { id: "p3", roundId: "r2", assignedTechnicianId: "t2" },
    ],
    visits: [
      { id: "v-today", roundId: "r1", status: "SCHEDULED", date: TODAY },
      { id: "v-tomorrow-skipped", roundId: "r1", status: "SKIPPED", date: TOMORROW },
      { id: "v-yesterday-unfinished", roundId: "r1", status: "SCHEDULED", date: YESTERDAY },
      { id: "v-done", roundId: "r1", status: "COMPLETED", date: YESTERDAY, invoice: true, payment: true, photos: 2 },
      { id: "v-done-today", roundId: "r1", status: "COMPLETED", date: TODAY, invoice: true },
      { id: "v-in-progress", roundId: "r1", status: "IN_PROGRESS", date: TODAY, photos: 1 },
      { id: "v-cancelled", roundId: "r1", status: "CANCELLED", date: TOMORROW },
      { id: "v-other-round", roundId: "r2", status: "SCHEDULED", date: TOMORROW },
    ],
    emergencies: [],
    chatMessages: [{ id: "c1", roundId: "r1", visitId: null }, { id: "c2", roundId: "r2", visitId: "v-other-round" }],
    chatReads: [{ profileId: "u1", roundId: "r1" }, { profileId: "u1", roundId: "r2" }],
    outbox: [
      { id: "o1", status: "pending", eventType: "message.send", payload: { visitId: "v-today" } },
      { id: "o2", status: "pending", eventType: "message.send", payload: { visitId: "v-other-round" } },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantToday.mockResolvedValue(TODAY);
});

describe("preview", () => {
  it("counts properties, upcoming (deleted) and detached visits; deletable when nothing blocks", async () => {
    const s = baseState();
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    expect(res).toEqual({
      propertyCount: 2,
      // today SCHEDULED + tomorrow SKIPPED
      upcomingVisitCount: 2,
      // yesterday's unfinished, both completed, in-progress, cancelled
      detachedVisitCount: 5,
      emergencyCount: 0,
      attachedVisitCount: 0,
      canDelete: true,
    });
  });

  it("uses the tenant's today: a visit dated yesterday is detached, not deleted", async () => {
    const s = baseState();
    tenantToday.mockResolvedValue(TOMORROW);
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    // From tomorrow's point of view only the skipped visit tomorrow is upcoming.
    expect(res.upcomingVisitCount).toBe(1);
    expect(res.detachedVisitCount).toBe(6);
  });

  it("reports emergencies and blocks", async () => {
    const s = baseState();
    s.emergencies.push({ id: "e1", roundId: "r1" }, { id: "e2", roundId: "r1" }, { id: "e3", roundId: "r2" });
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    expect(res).toMatchObject({ emergencyCount: 2, attachedVisitCount: 0, canDelete: false });
  });

  it.each([
    ["an invoice", { invoice: true }],
    ["an invoice line", { invoiceLine: true }],
    ["a payment", { payment: true }],
    ["a photo", { photos: 1 }],
    ["an issue", { issues: 2 }],
    ["a technician incident", { incidents: 1 }],
  ])("counts an upcoming visit with %s as attached and blocks", async (_label, extra) => {
    const s = baseState();
    Object.assign(s.visits[0], extra);
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    expect(res).toMatchObject({ attachedVisitCount: 1, canDelete: false, upcomingVisitCount: 2 });
  });

  it("counts an upcoming visit referenced by a chat message as attached", async () => {
    const s = baseState();
    s.chatMessages.push({ id: "c3", roundId: "r1", visitId: "v-tomorrow-skipped" }, { id: "c4", roundId: "r1", visitId: "v-tomorrow-skipped" });
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    expect(res).toMatchObject({ attachedVisitCount: 1, canDelete: false });
  });

  it("counts each attached visit once, whatever it carries; attachments on kept visits never block", async () => {
    const s = baseState();
    Object.assign(s.visits[0], { invoice: true, photos: 3, issues: 1 });
    s.chatMessages.push({ id: "c3", roundId: "r1", visitId: "v-today" }, { id: "c4", roundId: "r1", visitId: "v-tomorrow-skipped" });
    const res = await createRoundDeleteService(makePrisma(makeDb(s))).preview("r1");
    expect(res.attachedVisitCount).toBe(2);
  });

  it("skips the chat lookup for a round with no upcoming visits", async () => {
    const s = baseState();
    s.visits = s.visits.filter((v) => v.status === "COMPLETED");
    const db = makeDb(s);
    const res = await createRoundDeleteService(makePrisma(db)).preview("r1");
    expect(res).toMatchObject({ upcomingVisitCount: 0, detachedVisitCount: 2, canDelete: true });
    expect(db.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it("404s for a missing round", async () => {
    await expect(createRoundDeleteService(makePrisma(makeDb(baseState()))).preview("nope"))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("deleteRound", () => {
  it("in one transaction: deletes upcoming visits, detaches the rest and the properties, deletes the round", async () => {
    const s = baseState();
    const db = makeDb(s);
    const prisma = makePrisma(db, { txOnly: true });
    const res = await createRoundDeleteService(prisma).deleteRound("r1");

    expect(res).toEqual({ roundName: "Monday North", deleted: true, unassignedProperties: 2, deletedVisits: 2, detachedVisits: 5 });
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);

    // Round gone (its chat messages cascade), the other round untouched.
    expect(s.rounds.map((r) => r.id)).toEqual(["r2"]);
    expect(s.chatMessages.map((m) => m.id)).toEqual(["c2"]);
    expect(s.chatReads).toEqual([{ profileId: "u1", roundId: "r2" }]);

    // Upcoming SCHEDULED/SKIPPED visits deleted; everything else kept with no round.
    expect(s.visits.find((v) => v.id === "v-today")).toBeUndefined();
    expect(s.visits.find((v) => v.id === "v-tomorrow-skipped")).toBeUndefined();
    for (const id of ["v-yesterday-unfinished", "v-done", "v-done-today", "v-in-progress", "v-cancelled"]) {
      expect(s.visits.find((v) => v.id === id)).toMatchObject({ roundId: null });
    }
    expect(s.visits.find((v) => v.id === "v-other-round")).toMatchObject({ roundId: "r2" });

    // Properties unassigned (and their round technician split cleared); other round untouched.
    expect(s.properties).toEqual([
      { id: "p1", roundId: null, assignedTechnicianId: null },
      { id: "p2", roundId: null, assignedTechnicianId: null },
      { id: "p3", roundId: "r2", assignedTechnicianId: "t2" },
    ]);

    // Queued customer messages for the deleted visits cancelled, others left alone.
    expect(s.outbox.find((o) => o.id === "o1")).toMatchObject({ status: "cancelled", lastError: "Round deleted" });
    expect(s.outbox.find((o) => o.id === "o2")).toMatchObject({ status: "pending" });
  });

  it("only deletes visits that are still SCHEDULED/SKIPPED and dated today or later", async () => {
    const s = baseState();
    const db = makeDb(s);
    await createRoundDeleteService(makePrisma(db)).deleteRound("r1");
    expect(db.visit.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["v-today", "v-tomorrow-skipped"] }, roundId: "r1", status: { in: ["SCHEDULED", "SKIPPED"] }, date: { gte: TODAY } },
    });
  });

  it("does not touch customers' service plans", async () => {
    const s = baseState();
    const db = makeDb(s) as Db & { servicePlan?: unknown; customer?: unknown };
    const servicePlan = { updateMany: vi.fn(), update: vi.fn() };
    const prisma = makePrisma({ ...db, servicePlan } as unknown as Db);
    await createRoundDeleteService(prisma).deleteRound("r1");
    expect(servicePlan.updateMany).not.toHaveBeenCalled();
    expect(servicePlan.update).not.toHaveBeenCalled();
  });

  it("works for an empty round", async () => {
    const s = baseState();
    s.properties = s.properties.filter((p) => p.roundId !== "r1");
    s.visits = s.visits.filter((v) => v.roundId !== "r1");
    const db = makeDb(s);
    const res = await createRoundDeleteService(makePrisma(db)).deleteRound("r1");
    expect(res).toEqual({ roundName: "Monday North", deleted: true, unassignedProperties: 0, deletedVisits: 0, detachedVisits: 0 });
    expect(db.integrationOutbox.updateMany).not.toHaveBeenCalled();
    expect(s.rounds.map((r) => r.id)).toEqual(["r2"]);
  });

  it("404s for a missing round", async () => {
    await expect(createRoundDeleteService(makePrisma(makeDb(baseState()))).deleteRound("nope"))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("409 ROUND_HAS_EMERGENCIES with the count, changing nothing", async () => {
    const s = baseState();
    s.emergencies.push({ id: "e1", roundId: "r1" }, { id: "e2", roundId: "r1" });
    const db = makeDb(s);
    const err = await createRoundDeleteService(makePrisma(db)).deleteRound("r1").catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "ROUND_HAS_EMERGENCIES" });
    expect(err.message).toMatch(/2 emergenc/);
    expect(db.round.delete).not.toHaveBeenCalled();
    expect(db.visit.deleteMany).not.toHaveBeenCalled();
    expect(s.rounds).toHaveLength(2);
  });

  it.each([
    ["an invoice", { invoice: true }],
    ["an invoice line", { invoiceLine: true }],
    ["a payment", { payment: true }],
    ["a photo", { photos: 1 }],
    ["an issue", { issues: 1 }],
    ["a technician incident", { incidents: 1 }],
  ])("409 ROUND_HAS_ATTACHED_VISITS when an upcoming visit has %s", async (_label, extra) => {
    const s = baseState();
    Object.assign(s.visits[1], extra);
    const db = makeDb(s);
    const err = await createRoundDeleteService(makePrisma(db)).deleteRound("r1").catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "ROUND_HAS_ATTACHED_VISITS" });
    expect(err.message).toMatch(/1 upcoming visit/);
    expect(db.round.delete).not.toHaveBeenCalled();
    expect(db.visit.deleteMany).not.toHaveBeenCalled();
    expect(db.property.updateMany).not.toHaveBeenCalled();
  });

  it("409 ROUND_HAS_ATTACHED_VISITS when an upcoming visit is referenced by a chat message", async () => {
    const s = baseState();
    s.chatMessages.push({ id: "c3", roundId: "r1", visitId: "v-today" });
    const err = await createRoundDeleteService(makePrisma(makeDb(s))).deleteRound("r1").catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "ROUND_HAS_ATTACHED_VISITS" });
  });

  it("reports emergencies first when both block", async () => {
    const s = baseState();
    s.emergencies.push({ id: "e1", roundId: "r1" });
    Object.assign(s.visits[0], { payment: true });
    await expect(createRoundDeleteService(makePrisma(makeDb(s))).deleteRound("r1"))
      .rejects.toMatchObject({ statusCode: 409, code: "ROUND_HAS_EMERGENCIES" });
  });

  it("re-checks inside the transaction (an emergency raised after the preview still blocks)", async () => {
    const s = baseState();
    const db = makeDb(s);
    const prisma = makePrisma(db, { txOnly: true, beforeTx: () => s.emergencies.push({ id: "late", roundId: "r1" }) });
    await expect(createRoundDeleteService(prisma).deleteRound("r1"))
      .rejects.toMatchObject({ statusCode: 409, code: "ROUND_HAS_EMERGENCIES" });
    expect(db.round.delete).not.toHaveBeenCalled();
  });
});
