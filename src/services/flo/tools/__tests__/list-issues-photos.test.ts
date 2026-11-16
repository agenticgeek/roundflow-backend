import { describe, expect, it } from "vitest";
import { listIssuesPhotos } from "../list-issues-photos";
import { ctxFor, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const prop = (customer: string, addressLine: string) => ({ addressLine, customer: { name: customer }, ...SECRETS });
const issue = (type: string, at: string, over: Record<string, unknown> = {}) => ({
  type, createdAt: new Date(at), property: prop("Mrs Smith", "1 Oak Road"), visit: { property: prop("Visit Customer", "Visit Road") }, ...SECRETS, ...over,
});

const world = () =>
  fakePrisma({
    "issue.groupBy": [{ type: "GATE_LOCKED", _count: 2 }, { type: "ACCESS_PROBLEM", _count: 5 }, { type: "DOG_LOOSE", _count: 2 }],
    "issue.findMany": [issue("ACCESS_PROBLEM", "2026-11-05T10:00:00Z"), issue("GATE_LOCKED", "2026-11-04T10:00:00Z", { property: null })],
    "photo.count": (a: { where: { reviewStatus?: string; type?: string; complaintId?: unknown } }) => (a.where.reviewStatus ? 7 : a.where.type ? 3 : 4),
  });

describe("list_issues_photos", () => {
  it("validates input", () => {
    expect(listIssuesPhotos.parse({})).toEqual({ from: undefined, to: undefined, limit: 50 });
    expect(listIssuesPhotos.parse({ limit: 5, to: "2026-11-01" })).toMatchObject({ limit: 5, to: "2026-11-01" });
    expect(() => listIssuesPhotos.parse({ limit: 1000 })).toThrow(/1 to 200/);
    expect(() => listIssuesPhotos.parse({ type: "OTHER" })).toThrow(/Unknown argument/);
    expect(() => listIssuesPhotos.parse("x")).toThrow(/object/);
    expect(listIssuesPhotos.name).toBe("list_issues_photos");
    expect(listIssuesPhotos.readOnly).toBe(true);
  });

  it("counts issues by type, lists recent issues without notes and reports the photo queue", async () => {
    const fp = world();
    const out = await listIssuesPhotos.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    const blank = { label: null, count: null, date: null, customer: null, address: null };
    expect(out.rows).toEqual([
      { kind: "Issues by type", ...blank, label: "Access problem", count: 5 },
      { kind: "Issues by type", ...blank, label: "Dog loose", count: 2 },
      { kind: "Issues by type", ...blank, label: "Gate locked", count: 2 },
      { kind: "Recent issue", ...blank, label: "Access problem", date: "2026-11-05", customer: "Mrs Smith", address: "1 Oak Road" },
      { kind: "Recent issue", ...blank, label: "Gate locked", date: "2026-11-04", customer: "Visit Customer", address: "Visit Road" },
      { kind: "Photos", ...blank, label: "Awaiting review", count: 7 },
      { kind: "Photos", ...blank, label: "Attached to access issues", count: 3 },
      { kind: "Photos", ...blank, label: "Attached to complaints", count: 4 },
    ]);
    expect(out.totals).toEqual({ kind: "Total", label: null, count: 9, date: null, customer: null, address: null });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["kind", "label", "count", "date", "customer", "address"]);
    expectSafe(out, fp);
  });

  it("honours limit for recent issues and flags truncation", async () => {
    const fp = world();
    const out = await listIssuesPhotos.run({ limit: 1 }, ctxFor(fp.tp));
    expect(out.rows.filter((r) => r.kind === "Recent issue")).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect((fp.calls.find((c) => c.path === "issue.findMany")!.args as { take: number }).take).toBe(2);
  });

  it("with no data still reports zero photo counts and a zero total", async () => {
    const fp = fakePrisma();
    const out = await listIssuesPhotos.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.rows.map((r) => [r.kind, r.count])).toEqual([["Photos", 0], ["Photos", 0], ["Photos", 0]]);
    expect(out.totals).toMatchObject({ count: 0 });
  });

  it("rejects a bad range and uses tenant-local days (Auckland)", async () => {
    const fp = fakePrisma({}, { timezone: "Pacific/Auckland" });
    await expect(listIssuesPhotos.run({ from: "2026-11-10", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/must not be after/);
    await listIssuesPhotos.run({ from: "2026-11-10", to: "2026-11-10", limit: 50 }, ctxFor(fp.tp));
    const where = (fp.calls.find((c) => c.path === "issue.groupBy")!.args as { where: { createdAt: { gte: Date } } }).where.createdAt;
    expect(where.gte.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
});
