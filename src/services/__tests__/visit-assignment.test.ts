import { describe, it, expect, vi } from "vitest";
import {
  autoSplit,
  resolveTechnicianForVisit,
  restampFutureVisits,
  technicianIdsUnavailableOn,
  type TenantDb,
} from "../visit-assignment";

describe("resolveTechnicianForVisit", () => {
  it("uses the assigned technician when still on the round", () => {
    expect(resolveTechnicianForVisit({ assignedTechnicianId: "t2", roundTechnicianIds: ["t1", "t2"] })).toBe("t2");
  });

  it("ignores an assigned technician removed from the round, falling back to the sole technician", () => {
    expect(resolveTechnicianForVisit({ assignedTechnicianId: "gone", roundTechnicianIds: ["t1"] })).toBe("t1");
  });

  it("uses the sole round technician with no allocation", () => {
    expect(resolveTechnicianForVisit({ assignedTechnicianId: null, roundTechnicianIds: ["t1"] })).toBe("t1");
  });

  it("returns null for a multi-technician round with no allocation", () => {
    expect(resolveTechnicianForVisit({ assignedTechnicianId: null, roundTechnicianIds: ["t1", "t2"] })).toBeNull();
  });

  it("returns null for a round with no technicians", () => {
    expect(resolveTechnicianForVisit({ assignedTechnicianId: "t1", roundTechnicianIds: [] })).toBeNull();
  });

  it("skips an unavailable assigned technician for the only other available one", () => {
    expect(resolveTechnicianForVisit({
      assignedTechnicianId: "t1", roundTechnicianIds: ["t1", "t2"], unavailableTechnicianIds: ["t1"],
    })).toBe("t2");
  });

  it("returns null when everyone is unavailable", () => {
    expect(resolveTechnicianForVisit({
      assignedTechnicianId: null, roundTechnicianIds: ["t1"], unavailableTechnicianIds: ["t1"],
    })).toBeNull();
  });
});

describe("autoSplit", () => {
  const prop = (id: string, postcode: string | null, addressLine1: string | null) => ({ id, postcode, addressLine1 });

  it("returns an empty map for empty inputs", () => {
    expect(autoSplit([], ["t1"]).size).toBe(0);
    expect(autoSplit([prop("p1", "NE1 1AA", "1 A St")], []).size).toBe(0);
  });

  it("gives everything to a single technician", () => {
    const map = autoSplit([prop("p1", "NE1 1AA", "1 A St"), prop("p2", "NE2 1AA", "2 B St")], ["t1"]);
    expect([...map.values()]).toEqual(["t1", "t1"]);
  });

  it("splits two equal streets between two technicians, ordered by postcode then house number", () => {
    const map = autoSplit([
      prop("b2", "NE2 1AA", "10 Birch Road"),
      prop("a2", "NE1 1AA", "3 Ash Street"),
      prop("b1", "ne2 1aa", "2 Birch Road, Alnwick"),
      prop("a1", "NE11AA", "1 Ash Street"),
    ], ["t1", "t2"]);
    expect(Object.fromEntries(map)).toEqual({ a1: "t1", a2: "t1", b1: "t2", b2: "t2" });
  });

  it("keeps a long first street whole and still gives the next street to the second technician", () => {
    // Ash St (4) then Birch Rd (6): Birch starts at index 4 of 10 → rounds to chunk 1.
    const props = [
      ...[1, 2, 3, 4].map((n) => prop(`a${n}`, "NE1 1AA", `${n} Ash Street`)),
      ...[1, 2, 3, 4, 5, 6].map((n) => prop(`b${n}`, "NE1 1AA", `${n} Birch Road`)),
    ];
    const map = autoSplit([...props].reverse(), ["t1", "t2"]);
    expect(props.filter((p) => map.get(p.id) === "t1").map((p) => p.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(props.filter((p) => map.get(p.id) === "t2")).toHaveLength(6);
  });

  it("splits single-property streets across three technicians and clamps to the last chunk", () => {
    const props = ["A", "B", "C", "D", "E", "F", "G"].map((s, i) => prop(`p${i}`, "NE1 1AA", `1 ${s} Lane`));
    const map = autoSplit(props, ["t1", "t2", "t3"]);
    expect(props.map((p) => map.get(p.id))).toEqual(["t1", "t1", "t2", "t2", "t3", "t3", "t3"]);
  });

  it("clamps the final street onto the last technician", () => {
    // 5 single-property streets, 2 technicians: the last starts at 4 → round(1.6) = 2 → clamped to 1.
    const props = ["A", "B", "C", "D", "E"].map((s, i) => prop(`p${i}`, "NE1 1AA", `1 ${s} Lane`));
    const map = autoSplit(props, ["t1", "t2"]);
    expect(props.map((p) => map.get(p.id))).toEqual(["t1", "t1", "t2", "t2", "t2"]);
  });

  it("sorts unnumbered addresses after numbered ones, nulls last, ties by id — deterministically", () => {
    const props = [
      prop("z", null, null),
      prop("named", "NE1 1AA", "Rose Cottage"),
      prop("n2", "NE1 1AA", "rose cottage"),
      prop("num", "NE1 1AA", "12a Rose Cottage"),
    ];
    const a = autoSplit(props, ["t1", "t2"]);
    const b = autoSplit([...props].reverse(), ["t1", "t2"]);
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    // Sorted: num ("rose cottage", 12), n2, named ("rose cottage", no number; tie → id), z (null postcode).
    // The three Rose Cottage entries are one street → chunk 0; z starts at 3 of 4 → chunk 1.
    expect(a.get("num")).toBe("t1");
    expect(a.get("named")).toBe("t1");
    expect(a.get("n2")).toBe("t1");
    expect(a.get("z")).toBe("t2");
  });
});

function makeTp(opts: {
  roundTechs?: string[];
  visits?: Array<{ id: string; date: Date; technicianId: string | null; assignedTechnicianId: string | null }>;
  windows?: Array<{ technicianId: string; from: Date; to: Date }>;
}) {
  const tp = {
    roundTechnician: {
      findMany: vi.fn().mockResolvedValue((opts.roundTechs ?? []).map((technicianId) => ({ technicianId }))),
    },
    visit: {
      findMany: vi.fn().mockResolvedValue(
        (opts.visits ?? []).map((v) => ({
          id: v.id, date: v.date, technicianId: v.technicianId,
          property: { assignedTechnicianId: v.assignedTechnicianId },
        }))
      ),
      updateMany: vi.fn().mockImplementation(({ where }) => Promise.resolve({ count: where.id.in.length })),
    },
    technicianAvailability: { findMany: vi.fn().mockResolvedValue(opts.windows ?? []) },
  };
  return tp as typeof tp & TenantDb;
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("technicianIdsUnavailableOn", () => {
  it("queries windows covering the date and returns their technicians", async () => {
    const tp = makeTp({ windows: [{ technicianId: "t1", from: day("2026-10-01"), to: day("2026-11-01") }] });
    const result = await technicianIdsUnavailableOn(tp, day("2026-10-30"));
    expect([...result]).toEqual(["t1"]);
    expect(tp.technicianAvailability.findMany).toHaveBeenCalledWith({
      where: { from: { lte: day("2026-10-30") }, to: { gte: day("2026-10-30") } },
      select: { technicianId: true },
    });
  });
});

describe("restampFutureVisits", () => {
  it("returns 0 without further queries when there are no future visits", async () => {
    const tp = makeTp({ roundTechs: ["t1"] });
    expect(await restampFutureVisits(tp, "r1", new Date("2026-10-30T15:00:00Z"))).toBe(0);
    expect(tp.visit.findMany).toHaveBeenCalledWith({
      where: { roundId: "r1", status: "SCHEDULED", date: { gte: day("2026-10-30") }, technicianOverride: false },
      select: { id: true, date: true, technicianId: true, property: { select: { assignedTechnicianId: true } } },
    });
    expect(tp.technicianAvailability.findMany).not.toHaveBeenCalled();
    expect(tp.visit.updateMany).not.toHaveBeenCalled();
  });

  it("groups visits by resolved technician, skips no-ops and honours availability", async () => {
    const tp = makeTp({
      roundTechs: ["t1", "t2"],
      visits: [
        { id: "v1", date: day("2026-11-02"), technicianId: null, assignedTechnicianId: "t1" },
        { id: "v2", date: day("2026-11-03"), technicianId: null, assignedTechnicianId: "t1" },
        { id: "v3", date: day("2026-11-10"), technicianId: "t1", assignedTechnicianId: "t1" }, // t1 on leave → t2
        { id: "v4", date: day("2026-11-04"), technicianId: "t2", assignedTechnicianId: "t2" }, // unchanged
        { id: "v5", date: day("2026-11-05"), technicianId: "t1", assignedTechnicianId: null }, // 2 techs, none allocated → null
      ],
      windows: [{ technicianId: "t1", from: day("2026-11-09"), to: day("2026-11-13") }],
    });

    expect(await restampFutureVisits(tp, "r1", day("2026-10-30"))).toBe(4);
    expect(tp.technicianAvailability.findMany).toHaveBeenCalledWith({
      where: { technicianId: { in: ["t1", "t2"] }, to: { gte: day("2026-10-30") } },
      select: { technicianId: true, from: true, to: true },
    });
    expect(tp.visit.updateMany).toHaveBeenCalledTimes(3);
    expect(tp.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["v1", "v2"] } }, data: { technicianId: "t1" } });
    expect(tp.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["v3"] } }, data: { technicianId: "t2" } });
    expect(tp.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["v5"] } }, data: { technicianId: null } });
  });

  it("clears technicians when the round has none, without querying availability", async () => {
    const tp = makeTp({
      roundTechs: [],
      visits: [{ id: "v1", date: day("2026-11-02"), technicianId: "t9", assignedTechnicianId: "t9" }],
    });
    expect(await restampFutureVisits(tp, "r1", day("2026-10-30"))).toBe(1);
    expect(tp.technicianAvailability.findMany).not.toHaveBeenCalled();
    expect(tp.visit.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["v1"] } }, data: { technicianId: null } });
  });
});
