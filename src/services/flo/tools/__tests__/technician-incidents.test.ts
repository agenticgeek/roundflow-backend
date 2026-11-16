import { describe, expect, it } from "vitest";
import { technicianIncidents } from "../technician-incidents";
import { ctxFor, dec, fakePrisma } from "./fake-prisma";
import { expectSafe, SECRETS } from "./e2-test-utils";

const inc = (technicianId: string, name: string | null, type: string, amount: number | null) => ({
  technicianId, type, amount: amount === null ? null : dec(amount), technician: { name }, ...SECRETS,
});
const alert = (technicianId: string, name: string | null, metric: string, value: number, threshold: number) => ({
  technicianId, metric, value: dec(value), threshold: dec(threshold), technician: { name }, ...SECRETS,
});

const INCIDENTS = [
  inc("t1", "Liam", "STRIKE", null), inc("t1", "Liam", "STRIKE", null),
  inc("t1", "Liam", "DAMAGE", 45.5), inc("t1", "Liam", "DAMAGE", null),
  inc("t1", "Liam", "UPSELL", 20),
  inc("t2", "Abe", "UPSELL", 35), inc("t2", "Abe", "UPSELL", 15.25),
  inc("t3", null, "STRIKE", null),
];
const ALERTS = [alert("t1", "Liam", "complaints", 3, 2), alert("t4", "Zoe", "skipRate", 12.5, 10)];

describe("technician_incidents", () => {
  it("validates input", () => {
    expect(technicianIncidents.parse({})).toEqual({ from: undefined, to: undefined, technician: undefined, limit: 50 });
    expect(technicianIncidents.parse({ technician: " Liam ", from: "2026-10-01" })).toMatchObject({ technician: "Liam", from: "2026-10-01" });
    expect(() => technicianIncidents.parse({ technician: "x".repeat(81) })).toThrow(/at most 80/);
    expect(() => technicianIncidents.parse({ technician: 5 })).toThrow(/must be text/);
    expect(() => technicianIncidents.parse({ limit: 0 })).toThrow(/1 to 200/);
    expect(() => technicianIncidents.parse({ note: "x" })).toThrow(/Unknown argument/);
    expect(technicianIncidents.name).toBe("technician_incidents");
    expect(technicianIncidents.readOnly).toBe(true);
  });

  it("totals strikes, damage and upsell per technician and attaches KPI alerts, without notes", async () => {
    const fp = fakePrisma({ "technicianIncident.findMany": INCIDENTS, "kpiAlert.findMany": ALERTS });
    const out = await technicianIncidents.run({ limit: 50 }, ctxFor(fp.tp));
    expect(out.dateRange).toEqual({ from: "2026-11-01", to: "2026-11-10", label: "1 to 10 Nov 2026" });
    expect(out.rows).toEqual([
      { technician: "Liam", strikes: 2, damageCount: 2, damageAmount: 45.5, upsellCount: 1, upsellAmount: 20, kpiAlerts: 1, kpiAlertDetail: "complaints: 3 vs 2" },
      { technician: "Unnamed technician", strikes: 1, damageCount: 0, damageAmount: 0, upsellCount: 0, upsellAmount: 0, kpiAlerts: 0, kpiAlertDetail: null },
      { technician: "Abe", strikes: 0, damageCount: 0, damageAmount: 0, upsellCount: 2, upsellAmount: 50.25, kpiAlerts: 0, kpiAlertDetail: null },
      { technician: "Zoe", strikes: 0, damageCount: 0, damageAmount: 0, upsellCount: 0, upsellAmount: 0, kpiAlerts: 1, kpiAlertDetail: "skipRate: 12.5 vs 10" },
    ]);
    expect(out.totals).toEqual({ technician: "Total", strikes: 3, damageCount: 2, damageAmount: 45.5, upsellCount: 3, upsellAmount: 70.25, kpiAlerts: 2, kpiAlertDetail: null, technicians: 4 });
    expect(out.truncated).toBe(false);
    expect(out.columns.map((c) => c.key)).toEqual(["technician", "strikes", "damageCount", "damageAmount", "upsellCount", "upsellAmount", "kpiAlerts", "kpiAlertDetail"]);
    expectSafe(out, fp);
    const sel = (fp.calls.find((c) => c.path === "technicianIncident.findMany")!.args as { select: Record<string, unknown> }).select;
    expect(Object.keys(sel)).not.toContain("note");
  });

  it("caps the alert detail at five and passes the name filter and timestamp range", async () => {
    const many = Array.from({ length: 7 }, (_, i) => alert("t1", "Liam", `m${i}`, i, 1));
    const fp = fakePrisma({ "kpiAlert.findMany": many });
    const out = await technicianIncidents.run({ technician: "lia", limit: 50 }, ctxFor(fp.tp));
    expect(out.rows[0]).toMatchObject({ kpiAlerts: 7 });
    expect((out.rows[0].kpiAlertDetail as string).split("; ")).toHaveLength(5);
    const where = (fp.calls.find((c) => c.path === "kpiAlert.findMany")!.args as { where: { technician: unknown; createdAt: { gte: Date; lt: Date } } }).where;
    expect(where.technician).toEqual({ name: { contains: "lia", mode: "insensitive" } });
    expect(where.createdAt.lt.toISOString()).toBe("2026-11-11T00:00:00.000Z");
  });

  it("orders by damage cost then name and honours limit", async () => {
    const fp = fakePrisma({ "technicianIncident.findMany": [inc("a", "Zed", "DAMAGE", 5), inc("b", "Amy", "DAMAGE", 9), inc("c", "Bob", "DAMAGE", 9)] });
    const out = await technicianIncidents.run({ limit: 2 }, ctxFor(fp.tp));
    expect(out.rows.map((r) => r.technician)).toEqual(["Amy", "Bob"]);
    expect(out.truncated).toBe(true);
  });

  it("returns empty rows and null totals, flags capped scans, rejects a bad range", async () => {
    const fp = fakePrisma();
    expect(await technicianIncidents.run({ limit: 50 }, ctxFor(fp.tp))).toMatchObject({ rows: [], totals: null, truncated: false });
    const manyI = Array.from({ length: 20_001 }, () => inc("t1", "Liam", "STRIKE", null));
    expect((await technicianIncidents.run({ limit: 50 }, ctxFor(fakePrisma({ "technicianIncident.findMany": manyI }).tp))).truncated).toBe(true);
    const manyA = Array.from({ length: 20_001 }, () => alert("t1", "Liam", "m", 1, 1));
    expect((await technicianIncidents.run({ limit: 50 }, ctxFor(fakePrisma({ "kpiAlert.findMany": manyA }).tp))).truncated).toBe(true);
    await expect(technicianIncidents.run({ from: "2026-11-10", to: "2026-11-01", limit: 50 }, ctxFor(fp.tp))).rejects.toThrow(/must not be after/);
  });

  it("measures the range in tenant-local days (a 23:30 UTC incident belongs to the next day in Auckland)", async () => {
    const fp = fakePrisma({}, { timezone: "Pacific/Auckland" });
    await technicianIncidents.run({ from: "2026-11-10", to: "2026-11-10", limit: 50 }, ctxFor(fp.tp));
    const where = (fp.calls.find((c) => c.path === "technicianIncident.findMany")!.args as { where: { createdAt: { gte: Date; lt: Date } } }).where.createdAt;
    expect(where.gte.toISOString()).toBe("2026-11-09T11:00:00.000Z");
    expect(where.lt.toISOString()).toBe("2026-11-10T11:00:00.000Z");
  });
});
