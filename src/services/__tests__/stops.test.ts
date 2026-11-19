import { describe, expect, it } from "vitest";
import { VisitStatus } from "../../generated/tenant-client";
import { groupByStop, sortStopVisits, stopKeyOf, stopStatus, stopWhere } from "../stops";

const day = new Date("2026-11-19T00:00:00.000Z");

describe("stopKeyOf", () => {
  it("is property, day and technician", () => {
    expect(stopKeyOf({ propertyId: "p1", date: day, technicianId: "t1" })).toBe("p1|2026-11-19|t1");
  });

  it("uses the UTC day, so a time of day does not split a stop", () => {
    expect(stopKeyOf({ propertyId: "p1", date: new Date("2026-11-19T15:30:00.000Z"), technicianId: "t1" })).toBe(
      "p1|2026-11-19|t1",
    );
  });

  it("marks an unassigned visit with a dash", () => {
    expect(stopKeyOf({ propertyId: "p1", date: day, technicianId: null })).toBe("p1|2026-11-19|-");
  });

  it("separates technicians at the same property", () => {
    expect(stopKeyOf({ propertyId: "p1", date: day, technicianId: "t1" })).not.toBe(
      stopKeyOf({ propertyId: "p1", date: day, technicianId: "t2" }),
    );
  });
});

describe("sortStopVisits", () => {
  it("orders by createdAt, then id, without changing the input", () => {
    const a = { id: "b", createdAt: new Date("2026-01-01") };
    const b = { id: "a", createdAt: new Date("2026-01-01") };
    const c = { id: "z", createdAt: new Date("2025-12-01") };
    const input = [a, b, c];
    expect(sortStopVisits(input).map((v) => v.id)).toEqual(["z", "a", "b"]);
    expect(input.map((v) => v.id)).toEqual(["b", "a", "z"]);
  });

  it("breaks a createdAt tie by id whichever way round the input is", () => {
    const at = new Date("2026-01-01");
    expect(sortStopVisits([{ id: "a", createdAt: at }, { id: "b", createdAt: at }]).map((v) => v.id)).toEqual(["a", "b"]);
    expect(sortStopVisits([{ id: "b", createdAt: at }, { id: "a", createdAt: at }]).map((v) => v.id)).toEqual(["a", "b"]);
  });
});

describe("groupByStop", () => {
  const v = (id: string, key: string, created: string) => ({ id, key, createdAt: new Date(created) });

  it("keeps the order stops are first seen and sorts visits inside a stop", () => {
    const groups = groupByStop(
      [v("v3", "B", "2026-01-03"), v("v2", "A", "2026-01-02"), v("v1", "A", "2026-01-01"), v("v4", "B", "2026-01-01")],
      (x) => x.key,
    );
    expect(groups.map((g) => [g.key, g.visits.map((x) => x.id)])).toEqual([
      ["B", ["v4", "v3"]],
      ["A", ["v1", "v2"]],
    ]);
  });

  it("returns nothing for no visits", () => {
    expect(groupByStop([], () => "x")).toEqual([]);
  });
});

describe("stopStatus", () => {
  const { SCHEDULED, IN_PROGRESS, COMPLETED, SKIPPED, CANCELLED } = VisitStatus;

  it.each([
    [[SCHEDULED, SCHEDULED], SCHEDULED],
    [[SCHEDULED, IN_PROGRESS], IN_PROGRESS],
    [[COMPLETED, SCHEDULED], SCHEDULED],
    [[COMPLETED, IN_PROGRESS], IN_PROGRESS],
    [[COMPLETED, SKIPPED], COMPLETED],
    [[COMPLETED, COMPLETED], COMPLETED],
    [[SKIPPED, SKIPPED], SKIPPED],
    [[SKIPPED, CANCELLED], SKIPPED],
    [[COMPLETED, CANCELLED], COMPLETED],
  ])("%j -> %s", (statuses, expected) => {
    expect(stopStatus(statuses)).toBe(expected);
  });

  it("is SKIPPED when there is nothing but cancelled visits (never shown, but defined)", () => {
    expect(stopStatus([CANCELLED])).toBe(SKIPPED);
  });
});

describe("stopWhere", () => {
  it("matches the same property, day and technician, never cancelled", () => {
    expect(stopWhere({ propertyId: "p1", date: new Date("2026-11-19T10:00:00.000Z"), technicianId: "t1" })).toEqual({
      propertyId: "p1",
      technicianId: "t1",
      date: { gte: day, lt: new Date("2026-11-20T00:00:00.000Z") },
      status: { not: VisitStatus.CANCELLED },
    });
  });

  it("matches unassigned visits as a stop of their own", () => {
    expect(stopWhere({ propertyId: "p1", date: day, technicianId: null }).technicianId).toBeNull();
  });
});
