import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoundService } from "../round.service";
import { RoundStatus } from "../../generated/tenant-client";

// FLOW-01/02/03/04: PUT /rounds/:id/technicians generates due visits, reports
// generated / overridden / next-visit info and notifies technicians; reassign
// notifies the technicians involved. The collaborators are mocked; this file
// pins the orchestration.

const notifyEvent = vi.fn();
vi.mock("../notify", () => ({ notifyEvent: (...a: unknown[]) => notifyEvent(...a) }));

const generateForRound = vi.fn();
vi.mock("../../jobs/visitGeneration", () => ({ generateForRound: (...a: unknown[]) => generateForRound(...a) }));

const restampFutureVisits = vi.fn();
vi.mock("../visit-assignment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../visit-assignment")>()),
  restampFutureVisits: (...a: unknown[]) => restampFutureVisits(...a),
}));

vi.mock("../message.service", () => ({ createMessageService: vi.fn(() => ({ send: vi.fn() })) }));

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const ROUND = { id: "r1", name: "Alnwick North", frequency: "FOUR_WEEKLY", defaultDay: "MONDAY", status: RoundStatus.ACTIVE };

function makePrisma() {
  const prisma = {
    round: { findUnique: vi.fn().mockResolvedValue(ROUND) },
    technician: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, name: `Tech ${id}`, active: true, profileId: `prof-${id}` }))
      ),
      findUnique: vi.fn().mockResolvedValue({ id: "t2", active: true, profileId: "prof-t2" }),
    },
    property: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
    visit: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    roundTechnician: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue([]) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "Europe/London" }) },
    $transaction: vi.fn(),
  };
  mock(prisma.$transaction).mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyEvent.mockResolvedValue(1);
  generateForRound.mockResolvedValue(0);
  restampFutureVisits.mockResolvedValue(0);
});

const svc = (p: ReturnType<typeof makePrisma>) => createRoundService(p as never);

describe("setTechnicians: BUG-011 duplicate technician ids and concurrent saves", () => {
  it("a repeated technician id is saved once (no unique violation)", async () => {
    const prisma = makePrisma();
    await svc(prisma).setTechnicians("r1", ["t1", "t1", "t2", "t1"]);
    expect(mock(prisma.roundTechnician.createMany)).toHaveBeenCalledWith({
      data: [{ roundId: "r1", technicianId: "t1" }, { roundId: "r1", technicianId: "t2" }],
      skipDuplicates: true,
    });
  });

  it("a unique violation from a simultaneous save of the same round is a clean 409, not a 500", async () => {
    const prisma = makePrisma();
    mock(prisma.roundTechnician.createMany).mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    await expect(svc(prisma).setTechnicians("r1", ["t1"])).rejects.toMatchObject({ statusCode: 409, code: "ROUND_TECHNICIANS_CONFLICT" });
    mock(prisma.roundTechnician.createMany).mockRejectedValueOnce(new Error("db down"));
    await expect(svc(prisma).setTechnicians("r1", ["t1"])).rejects.toThrow("db down");
  });
});

describe("setTechnicians: FLOW-01 / FLOW-02 / FLOW-04", () => {
  it("generates due visits after the assignment and reports generated, overridden and next visit date", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.count).mockResolvedValue(2);
    mock(prisma.visit.findFirst)
      .mockResolvedValueOnce(null) // summary inside the transaction: nothing yet
      .mockResolvedValueOnce({ date: new Date("2026-11-09T00:00:00.000Z") }); // after generation
    generateForRound.mockResolvedValue(3);
    restampFutureVisits.mockResolvedValue(1);

    const result = await svc(prisma).setTechnicians("r1", ["t1"]);

    expect(generateForRound).toHaveBeenCalledWith(prisma, ROUND, expect.any(Date));
    // Generation runs after the transaction committed (so it sees the new allocation).
    expect(generateForRound.mock.invocationCallOrder[0]).toBeGreaterThan(mock(prisma.$transaction).mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      roundId: "r1",
      visitsUpdated: 1,
      visitsGenerated: 3,
      overriddenVisits: 2,
      nextVisitDate: "2026-11-09",
    });
    expect(prisma.visit.count).toHaveBeenCalledWith({
      where: { roundId: "r1", status: "SCHEDULED", date: { gte: expect.any(Date) }, technicianOverride: true },
    });
  });

  it("keeps the in-transaction next visit date when nothing was generated", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.findFirst).mockResolvedValue({ date: new Date("2026-11-16T00:00:00.000Z") });
    const result = await svc(prisma).setTechnicians("r1", ["t1"]);
    expect(result.visitsGenerated).toBe(0);
    expect(result.nextVisitDate).toBe("2026-11-16");
    expect(prisma.visit.findFirst).toHaveBeenCalledTimes(1);
  });

  it("nextVisitDate is null when the round has no upcoming visits", async () => {
    const prisma = makePrisma();
    const result = await svc(prisma).setTechnicians("r1", ["t1"]);
    expect(result.nextVisitDate).toBeNull();
    expect(result.overriddenVisits).toBe(0);
  });

  it("dryRun writes nothing: no generation, no notifications, still reports overridden and next date", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.count).mockResolvedValue(4);
    mock(prisma.visit.findFirst).mockResolvedValue({ date: new Date("2026-11-10T00:00:00.000Z") });
    let rolledBack = false;
    mock(prisma.$transaction).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        return await fn(prisma);
      } catch (e) {
        rolledBack = true;
        throw e;
      }
    });

    const result = await svc(prisma).setTechnicians("r1", ["t1"], undefined, { dryRun: true });

    expect(rolledBack).toBe(true);
    expect(generateForRound).not.toHaveBeenCalled();
    expect(notifyEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ visitsGenerated: 0, overriddenVisits: 4, nextVisitDate: "2026-11-10" });
  });

  it("does not generate for a non-ACTIVE round or when the list is cleared", async () => {
    const paused = makePrisma();
    mock(paused.round.findUnique).mockResolvedValue({ ...ROUND, status: RoundStatus.DRAFT });
    expect((await svc(paused).setTechnicians("r1", ["t1"])).visitsGenerated).toBe(0);

    const cleared = makePrisma();
    expect((await svc(cleared).setTechnicians("r1", [])).visitsGenerated).toBe(0);
    expect(generateForRound).not.toHaveBeenCalled();
  });
});

describe("setTechnicians: FLOW-03 notifications", () => {
  function withVisits(prisma: ReturnType<typeof makePrisma>, rows: Array<{ technicianId: string; date: string }>) {
    mock(prisma.visit.findMany).mockResolvedValue(rows.map((r) => ({ technicianId: r.technicianId, date: new Date(`${r.date}T00:00:00.000Z`) })));
  }

  it("tells a newly assigned technician how many visits they got, with the first date", async () => {
    const prisma = makePrisma();
    mock(prisma.roundTechnician.findMany).mockResolvedValue([]); // nobody before
    withVisits(prisma, [
      { technicianId: "t1", date: "2026-11-16" },
      { technicianId: "t1", date: "2026-11-09" },
    ]);

    await svc(prisma).setTechnicians("r1", ["t1"]);

    expect(notifyEvent).toHaveBeenCalledWith(prisma, {
      type: "SCHEDULE",
      title: "2 visits assigned to you",
      body: "Alnwick North: first visit 2026-11-09.",
      data: { roundId: "r1", date: "2026-11-09" },
      to: { technicianIds: ["t1"] },
    });
  });

  it("uses the singular for one visit and a ROUND_UPDATE when no visits exist yet", async () => {
    const prisma = makePrisma();
    mock(prisma.roundTechnician.findMany).mockResolvedValue([]);
    withVisits(prisma, [{ technicianId: "t1", date: "2026-11-09" }]);
    await svc(prisma).setTechnicians("r1", ["t1", "t2"]);

    expect(notifyEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({
      type: "SCHEDULE", title: "1 visit assigned to you", to: { technicianIds: ["t1"] },
    }));
    expect(notifyEvent).toHaveBeenCalledWith(prisma, {
      type: "ROUND_UPDATE",
      title: "You have been added to a round",
      body: "Alnwick North: no visits are scheduled yet.",
      data: { roundId: "r1" },
      to: { technicianIds: ["t2"] },
    });
  });

  it("tells removed technicians they are off the round", async () => {
    const prisma = makePrisma();
    mock(prisma.roundTechnician.findMany).mockResolvedValue([{ technicianId: "t1" }, { technicianId: "t9" }]);
    await svc(prisma).setTechnicians("r1", ["t1"]);

    expect(notifyEvent).toHaveBeenCalledTimes(1);
    expect(notifyEvent).toHaveBeenCalledWith(prisma, {
      type: "ROUND_UPDATE",
      title: "You have been removed from a round",
      body: "Alnwick North: its visits are no longer on your schedule.",
      data: { roundId: "r1" },
      to: { technicianIds: ["t9"] },
    });
  });

  it("tells retained technicians only when their visits actually changed", async () => {
    const changed = makePrisma();
    mock(changed.roundTechnician.findMany).mockResolvedValue([{ technicianId: "t1" }]);
    restampFutureVisits.mockResolvedValue(2);
    await svc(changed).setTechnicians("r1", ["t1"]);
    expect(notifyEvent).toHaveBeenCalledWith(changed, {
      type: "ROUND_UPDATE",
      title: "Your schedule on a round changed",
      body: "Alnwick North: some of your visits were updated.",
      data: { roundId: "r1" },
      to: { technicianIds: ["t1"] },
    });

    notifyEvent.mockClear();
    const unchanged = makePrisma();
    mock(unchanged.roundTechnician.findMany).mockResolvedValue([{ technicianId: "t1" }]);
    restampFutureVisits.mockResolvedValue(0);
    await svc(unchanged).setTechnicians("r1", ["t1"]);
    expect(notifyEvent).not.toHaveBeenCalled();
  });

  it("sends nothing when the technician list is unchanged and cleared lists notify nobody new", async () => {
    const prisma = makePrisma();
    mock(prisma.roundTechnician.findMany).mockResolvedValue([]);
    await svc(prisma).setTechnicians("r1", []);
    expect(notifyEvent).not.toHaveBeenCalled();
  });
});

describe("reassignTechnician: FLOW-03 notifications", () => {
  const future = () => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };

  it("one-off: notifies the receiving and the releasing technician with the date and count", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.updateMany).mockResolvedValue({ count: 3 });
    const date = future();
    const day = date.toISOString().slice(0, 10);

    await svc(prisma).reassignTechnician("r1", { date, fromTechnicianId: "t1", toTechnicianId: "t2", scope: "ALL", notify: false });

    expect(notifyEvent).toHaveBeenCalledWith(prisma, {
      type: "SCHEDULE",
      title: "3 visits assigned to you",
      body: `Alnwick North: reassigned to you for ${day}.`,
      data: { roundId: "r1", date: day },
      to: { technicianIds: ["t2"] },
    });
    expect(notifyEvent).toHaveBeenCalledWith(prisma, {
      type: "SCHEDULE",
      title: "3 visits moved off your schedule",
      body: `Alnwick North: reassigned to another technician for ${day}.`,
      data: { roundId: "r1", date: day },
      to: { technicianIds: ["t1"] },
    });
  });

  it("does not notify when nothing moved; unassigned source notifies only the receiver", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.updateMany).mockResolvedValue({ count: 0 });
    await svc(prisma).reassignTechnician("r1", { date: future(), fromTechnicianId: null, toTechnicianId: "t2", scope: "ALL", notify: false });
    expect(notifyEvent).not.toHaveBeenCalled();

    mock(prisma.visit.updateMany).mockResolvedValue({ count: 1 });
    await svc(prisma).reassignTechnician("r1", { date: future(), fromTechnicianId: null, toTechnicianId: "t2", scope: "ALL", notify: false });
    expect(notifyEvent).toHaveBeenCalledTimes(1);
    expect(notifyEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({ title: "1 visit assigned to you", to: { technicianIds: ["t2"] } }));
  });

  it("permanent: notifies with the number of visits moved", async () => {
    const prisma = makePrisma();
    mock(prisma.visit.findMany).mockResolvedValue([{ id: "v1", propertyId: "p1" }]);
    mock(prisma.visit.updateMany).mockResolvedValue({ count: 1 });
    restampFutureVisits.mockResolvedValue(4);
    const date = future();

    const result = await svc(prisma).reassignTechnician("r1", {
      date, fromTechnicianId: "t1", toTechnicianId: "t2", scope: "REMAINING", permanent: true, notify: false,
    });

    expect(result).toEqual({ updated: 5 });
    expect(notifyEvent).toHaveBeenCalledWith(prisma, expect.objectContaining({ title: "1 visit assigned to you" }));
  });
});
