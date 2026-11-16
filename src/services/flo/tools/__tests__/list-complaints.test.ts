import { describe, expect, it } from "vitest";
import { listComplaints } from "../list-complaints";
import { ctxFor, fakePrisma } from "./fake-prisma";

const c = (over: Record<string, unknown> = {}) => ({
  title: "Streaks", severity: "HIGH", status: "OPEN", createdAt: new Date("2026-11-01T10:00:00Z"), revisitDate: null,
  issueType: null, upheld: null, resolvedAt: null,
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
      "complaint.groupBy": [
        { severity: "HIGH", technicianId: "t1", upheld: null, _count: 1 },
        { severity: "LOW", technicianId: null, upheld: null, _count: 1 },
      ],
      "technician.findMany": [{ id: "t1", name: "Liam" }],
      "complaint.findMany": [
        c(),
        c({ title: "Missed", severity: "LOW", status: "REVISIT_BOOKED", createdAt: new Date("2026-11-09T23:30:00Z"), revisitDate: new Date("2026-11-12T00:00:00Z"), property: null, technician: null }),
      ],
    });
    const out = await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 50 }, ctxFor(tp));
    expect(out.rows).toEqual([
      { customer: "Mrs Smith", address: "1 Oak Road", title: "Streaks", severity: "HIGH", status: "OPEN", technician: "Liam", ageDays: 9, logged: "2026-11-01", revisitDate: null, issueType: null, upheld: null, resolvedAt: null, daysToResolve: null },
      { customer: "Mrs Smith", address: null, title: "Missed", severity: "LOW", status: "REVISIT_BOOKED", technician: null, ageDays: 1, logged: "2026-11-09", revisitDate: "2026-11-12", issueType: null, upheld: null, resolvedAt: null, daysToResolve: null },
    ]);
    expect(out.totals).toEqual({
      customer: "Total", complaints: 2, highCount: 1, mediumCount: 0, lowCount: 1, upheldCount: 0, notUpheldCount: 0, upheldRate: null,
      byTechnician: "Liam: 1; Unassigned: 1", topTechnician: "Liam", topTechnicianCount: 1,
    });
    expect(out.columns.map((x) => x.key)).toEqual([
      "customer", "address", "title", "severity", "status", "technician", "ageDays", "logged", "revisitDate", "issueType", "upheld", "resolvedAt", "daysToResolve",
    ]);
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

  it("shows resolution details (issue type, outcome, resolved day in tenant time, days to resolve) without notes or descriptions", async () => {
    const { tp, calls } = fakePrisma({
      "complaint.count": 2,
      "complaint.findMany": [
        c({ status: "RESOLVED", issueType: "Streaks", upheld: true, createdAt: new Date("2026-10-01T10:00:00Z"), resolvedAt: new Date("2026-10-06T23:30:00Z") }),
        c({ status: "RESOLVED", upheld: false, createdAt: new Date("2026-10-10T10:00:00Z"), resolvedAt: new Date("2026-10-10T11:00:00Z") }),
      ],
    });
    const out = await listComplaints.run({ status: "RESOLVED", sort: "newest", limit: 10 }, ctxFor(tp));
    // 23:30Z on 6 Oct is 00:30 BST on the 7th: resolved on the 7th, 6 days after being logged on the 1st.
    expect(out.rows[0]).toMatchObject({ issueType: "Streaks", upheld: "Upheld", resolvedAt: "2026-10-07", daysToResolve: 6 });
    expect(out.rows[1]).toMatchObject({ issueType: null, upheld: "Not upheld", resolvedAt: "2026-10-10", daysToResolve: 0 });
    const select = (calls.find((x) => x.path === "complaint.findMany")!.args as { select: Record<string, unknown> }).select;
    expect(Object.keys(select)).toEqual(expect.arrayContaining(["issueType", "upheld", "resolvedAt"]));
    expect(Object.keys(select)).not.toEqual(expect.arrayContaining(["notes"]));
    expect(Object.keys(select)).not.toContain("description");
  });

  it("totals by severity, technician and upheld rate from a groupBy over every match (exact beyond the row cap)", async () => {
    const g = (severity: string, technicianId: string | null, upheld: boolean | null, n: number) => ({ severity, technicianId, upheld, _count: n });
    const { tp, calls } = fakePrisma({
      "complaint.count": 40,
      "complaint.groupBy": [
        g("HIGH", "t1", true, 6), g("HIGH", "t2", false, 4), g("MEDIUM", "t1", null, 10), g("LOW", "t3", true, 2),
        g("LOW", null, null, 5), g("MEDIUM", "t9", false, 9), g("WEIRD", "t2", null, 4),
      ],
      "technician.findMany": [{ id: "t1", name: "Liam" }, { id: "t2", name: null }, { id: "t3", name: "Ana" }],
      "complaint.findMany": [c()],
    });
    const out = await listComplaints.run({ status: "RESOLVED", sort: "oldest", limit: 1 }, ctxFor(tp));
    expect(out.truncated).toBe(true);
    // upheld 8, not upheld 13: rate 8/21
    expect(out.totals).toMatchObject({
      complaints: 40, highCount: 10, mediumCount: 19, lowCount: 7, upheldCount: 8, notUpheldCount: 13, upheldRate: 38.1,
      byTechnician: "Liam: 16; Unnamed technician: 8; Unknown technician: 9; Unassigned: 5; Ana: 2".split("; ").sort((a, b) => Number(b.split(": ")[1]) - Number(a.split(": ")[1]) || a.localeCompare(b)).join("; "),
      topTechnician: "Liam", topTechnicianCount: 16,
    });
    expect((calls.find((x) => x.path === "complaint.groupBy")!.args as { by: string[] }).by).toEqual(["severity", "technicianId", "upheld"]);
  });

  it("has a null upheld rate and no top technician when nothing is decided or assigned", async () => {
    const { tp } = fakePrisma({
      "complaint.count": 2,
      "complaint.groupBy": [{ severity: "LOW", technicianId: null, upheld: null, _count: 2 }],
      "complaint.findMany": [c()],
    });
    const out = await listComplaints.run({ status: "UNRESOLVED", sort: "severity", limit: 5 }, ctxFor(tp));
    expect(out.totals).toMatchObject({ upheldRate: null, byTechnician: "Unassigned: 2", topTechnician: null, topTechnicianCount: null });
  });

  it("describes when not to use it, an example, the field glossary and the KPI-definition caveat", () => {
    expect(listComplaints.description).toMatch(/Do NOT use/);
    expect(listComplaints.description).toMatch(/Example: \{/);
    expect(listComplaints.description).toMatch(/Fields:/);
    expect(listComplaints.description).toMatch(/compare_technicians counts complaints logged/);
  });
});
