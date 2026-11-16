import { describe, expect, it } from "vitest";
import { listTechnicians } from "../list-technicians";
import { executeTool } from "../../tool-registry";
import { ctxFor, fakePrisma } from "./fake-prisma";

describe("list_technicians", () => {
  it("lists the roster with rounds and areas, independent of any date range", async () => {
    const { tp, calls } = fakePrisma({
      "businessSettings.findFirst": { timezone: "Europe/London" },
      "technician.findMany": [
        { name: "Liam", role: "Cleaner", active: true, _count: { roundTechnicians: 2 }, serviceAreas: [{ serviceArea: { name: "Wirral" } }, { serviceArea: { name: "Chester" } }] },
        { name: null, role: null, active: false, _count: { roundTechnicians: 0 }, serviceAreas: [] },
      ],
    });
    const out = await executeTool("list_technicians", { status: "ALL" }, ctxFor(tp), "r1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.dateRange).toBeNull();
    expect(out.result.rows).toEqual([
      { technician: "Liam", role: "Cleaner", status: "Active", rounds: 2, serviceAreas: "Chester, Wirral" },
      { technician: "Unnamed technician", role: null, status: "Inactive", rounds: 0, serviceAreas: null },
    ]);
    expect(out.result.totals).toEqual({ technician: "Total", technicians: 2 });
    expect(JSON.stringify(calls.find((c) => c.path === "technician.findMany")?.args)).not.toContain("phone");
  });

  it("defaults to active technicians and rejects unknown arguments", async () => {
    const { tp, calls } = fakePrisma({ "businessSettings.findFirst": { timezone: "Europe/London" }, "technician.findMany": [] });
    const out = await executeTool("list_technicians", {}, ctxFor(tp), "r1");
    expect(out.ok && out.result.rows).toEqual([]);
    expect((calls.find((c) => c.path === "technician.findMany")?.args as { where: unknown }).where).toEqual({ active: true });
    expect((await executeTool("list_technicians", { status: "x" }, ctxFor(tp), "r2")).ok).toBe(false);
  });

  it("describes when not to use it, an example and the output fields", () => {
    expect(listTechnicians.description).toMatch(/Do NOT use/);
    expect(listTechnicians.description).toMatch(/Example: \{/);
    expect(listTechnicians.description).toMatch(/Fields:/);
  });
});
