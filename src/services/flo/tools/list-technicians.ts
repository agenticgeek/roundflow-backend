import type { ResultRow, ToolDefinition } from "../types";
import { columns, MAX_LIMIT, optEnum, parseArgs } from "./shared";

// list_technicians(status?): the roster. "Who are my technicians / how many do I have / who is on Round 7" must never
// depend on a technician having completed a visit in some period (that is compare_technicians), so this reads the
// Technician table itself plus their round and service-area assignments. Contact details are deliberately not selected.

const STATUSES = ["ACTIVE", "INACTIVE", "ALL"] as const;

interface Args {
  status: (typeof STATUSES)[number];
}

const COLUMNS = columns(
  ["technician", "Technician", "text"],
  ["role", "Role", "text"],
  ["status", "Status", "text"],
  ["rounds", "Rounds assigned", "integer"],
  ["serviceAreas", "Service areas", "text"]
);

export const listTechnicians: ToolDefinition<Args> = {
  name: "list_technicians",
  label: "Technician roster",
  readOnly: true,
  description:
    "The list of technicians the business has: name, role, active or inactive, how many rounds each is assigned to and their service areas. Use for 'who are my technicians', 'how many technicians do I have' and 'who is on which round'. This is the roster and does not depend on any date range. For performance or revenue use compare_technicians. status defaults to ACTIVE; use ALL to include inactive technicians. " +
    "Do NOT use for jobs, revenue, skips or complaints (use compare_technicians) or for who is off or free next week (use technician_workload). " +
    "Example: {\"status\":\"ALL\"}. " +
    "Fields: rounds = number of rounds the technician is assigned to; serviceAreas = comma-separated area names; status is Active or Inactive; totals.technicians = how many are listed.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", enum: [...STATUSES], description: "Default ACTIVE" } },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["status"]);
    return { status: optEnum(obj, "status", STATUSES) ?? "ACTIVE" };
  },
  async run(args, ctx) {
    const found = await ctx.tenantPrisma.technician.findMany({
      where: args.status === "ALL" ? {} : { active: args.status === "ACTIVE" },
      select: {
        name: true,
        role: true,
        active: true,
        _count: { select: { roundTechnicians: true } },
        serviceAreas: { select: { serviceArea: { select: { name: true } } } },
      },
      orderBy: { name: "asc" },
      take: MAX_LIMIT + 1,
    });
    const rows: ResultRow[] = found.slice(0, MAX_LIMIT).map((t) => ({
      technician: t.name ?? "Unnamed technician",
      role: t.role ?? null,
      status: t.active === false ? "Inactive" : "Active",
      rounds: t._count?.roundTechnicians ?? 0,
      serviceAreas: (t.serviceAreas ?? []).map((a) => a.serviceArea.name).sort().join(", ") || null,
    }));
    return {
      dateRange: null,
      rows,
      totals: rows.length === 0 ? null : { technician: "Total", technicians: rows.length },
      truncated: found.length > MAX_LIMIT,
      columns: COLUMNS,
    };
  },
};
