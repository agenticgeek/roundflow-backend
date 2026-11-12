import { describe, expect, it } from "vitest";
import { listComplaints } from "../list-complaints";
import { ctxFor, fakePrisma } from "./fake-prisma";

const c = (over: Record<string, unknown> = {}) => ({
  title: "Streaks", severity: "HIGH", status: "OPEN", createdAt: new Date("2026-11-01T10:00:00Z"), revisitDate: null,
  customer: { name: "Mrs Smith" }, property: { addressLine: "1 Oak Road" }, technician: { name: "Liam" }, ...over,
});

describe("list_complaints", () => {
  it("validates input and applies defaults", () => {
    expect(listComplaints.parse({})).toEqual({ status: "UNRESOLVED", severity: undefined, sort: "severity", limit: 50 });
    expect(listComplaints.parse({ status: "RESOLVED", severity: "LOW", sort: "newest", limit: 3 })).toEqual({ status: "RESOLVED", severity: "LOW", sort: "newest", limit: 3 });
    expect(() => listComplaints.parse({ status: "DONE" })).toThrow(/must be one of/);
    expect(() => listComplaints.parse({ severity: "SEVERE" })).toThrow(/must be one of/);
    expect(() => listComplaints.parse({ sort: "random" })).toThrow(/must be one of/);
  });

  it("lists unresolved complaints by severity then oldest, with age in tenant-local days", async () => {
    const { tp, calls } = fakePrisma({
      "complaint.count": 2,
      "complaint.findMany": [
        c(),
        c({ title: "Missed", severity: "LOW", status: "REVISIT_BOOKED", createdAt: new Date("2026-11-09T23:30:00Z"), revisitDate: new Date("2026-11-12T00:00:00Z"), property: null, technician: null }),
      ],
    });
    const out = await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Mrs Smith", address: "1 Oak Road", title: "Streaks", severity: "HIGH", status: "OPEN", technician: "Liam", ageDays: 9, logged: "2026-11-01", revisitDate: null },
      { customer: "Mrs Smith", address: null, title: "Missed", severity: "LOW", status: "REVISIT_BOOKED", technician: null, ageDays: 1, logged: "2026-11-09", revisitDate: "2026-11-12" },
    ]);
    expect(out.totals).toEqual({ customer: "Total", complaints: 2 });
    expect(out).toMatchObject({ dateRange: null, truncated: false });
    const fm = calls.find((x) => x.path === "complaint.findMany")!.args as { where: unknown; orderBy: unknown; select: Record<string, unknown> };
    expect(fm.where).toEqual({ status: { not: "RESOLVED" } });
    expect(fm.orderBy).toEqual([{ severity: "desc" }, { createdAt: "asc" }]);
    expect(Object.keys(fm.select)).not.toContain("description");
  });

  it("supports status/severity filters and the oldest and newest sorts", async () => {
    const a = fakePrisma();
    await listComplaints.run({ status: "OPEN", severity: "HIGH", sort: "oldest", limit: 10 }, ctxFor(a.tp));
    const args = a.calls.find((x) => x.path === "complaint.findMany")!.args as { where: unknown; orderBy: unknown; take: number };
    expect(args).toMatchObject({ where: { status: "OPEN", severity: "HIGH" }, orderBy: [{ createdAt: "asc" }], take: 10 });
    const b = fakePrisma();
    await listComplaints.run({ status: "RESOLVED", sort: "newest", limit: 10 }, ctxFor(b.tp));
    expect((b.calls.find((x) => x.path === "complaint.findMany")!.args as { orderBy: unknown }).orderBy).toEqual([{ createdAt: "desc" }]);
  });

  it("flags truncation from the total and returns null totals when empty", async () => {
    const { tp } = fakePrisma({ "complaint.count": 120, "complaint.findMany": [c()] });
    expect(await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 1 }, ctxFor(tp))).toMatchObject({ truncated: true, totals: { complaints: 120 } });
    const empty = fakePrisma();
    expect(await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 1 }, ctxFor(empty.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
  });

  it("never reports a negative age for a complaint logged later today", async () => {
    const { tp } = fakePrisma({ "complaint.count": 1, "complaint.findMany": [c({ createdAt: new Date("2026-11-10T09:30:00Z") })] });
    const out = await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 5 }, ctxFor(tp, "2026-11-10T09:00:00Z"));
    expect(out.rows[0].ageDays).toBe(0);
  });
});
