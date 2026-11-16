import { ComplaintStatus, Severity } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { breakdownText, columns, daysBetween, localDayOf, optEnum, parseArgs, parseLimit, pct, tenantClock, topEntry } from "./shared";

// list_complaints(status?, severity?, sort?, limit?): the complaints list (same fields as complaint.service) with an
// age in days. Severity ordering and the UNRESOLVED filter are not in complaint.service.listComplaints (it pages by
// newest first and can't sort by severity), so this is one read-only query on the same model. The totals (by severity,
// by technician, upheld rate) come from a groupBy over every match, so they are exact even when the list is capped.

const STATUSES = ["UNRESOLVED", ...Object.values(ComplaintStatus)] as const;
const SEVERITIES = Object.values(Severity) as Severity[];
const SORTS = ["severity", "oldest", "newest"] as const;

interface Args {
  status: (typeof STATUSES)[number];
  severity?: Severity;
  sort: (typeof SORTS)[number];
  limit: number;
}

const COLUMNS = columns(
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["title", "Complaint", "text"],
  ["severity", "Severity", "text"],
  ["status", "Status", "text"],
  ["technician", "Technician", "text"],
  ["ageDays", "Age (days)", "integer"],
  ["logged", "Logged", "date"],
  ["revisitDate", "Revisit", "date"],
  ["issueType", "Issue type", "text"],
  ["upheld", "Outcome", "text"],
  ["resolvedAt", "Resolved", "date"],
  ["daysToResolve", "Days to resolve", "integer"]
);

export const listComplaints: ToolDefinition<Args> = {
  name: "list_complaints",
  label: "Complaints",
  readOnly: true,
  description:
    "Complaints with customer, property, technician, severity, status, issue type, outcome and age in days. status defaults to UNRESOLVED (anything not resolved); or OPEN, IN_REVIEW, REVISIT_BOOKED, RESOLVED. severity LOW, MEDIUM or HIGH. sort: severity (highest first, then oldest first; the default), oldest, newest. Use for 'open complaints by severity, oldest first' and 'how many complaints did Liam get'. " +
    "Do NOT use for a technician's performance over a month (use compare_technicians) or for customers likely to leave (use list_at_risk_customers). " +
    "Complaint counts here are by CURRENT status across all dates; compare_technicians counts complaints logged inside a period via the technician KPI service, so the two can differ: never mix them in one sentence. " +
    "Example: {\"status\":\"RESOLVED\",\"severity\":\"HIGH\",\"sort\":\"newest\",\"limit\":20}. " +
    "Fields: ageDays = days since logged; upheld = Upheld, Not upheld or empty (decided on resolve; upheld complaints count as technician strikes); daysToResolve = days from logged to resolved (empty while open). " +
    "Totals (exact over every match): complaints, highCount / mediumCount / lowCount, upheldCount, notUpheldCount, upheldRate = upheld / decided as a percentage (null when none decided), byTechnician = 'Name: count' list, topTechnician and topTechnicianCount.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...STATUSES] },
      severity: { type: "string", enum: SEVERITIES },
      sort: { type: "string", enum: [...SORTS] },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["status", "severity", "sort", "limit"]);
    return {
      status: optEnum(obj, "status", STATUSES) ?? "UNRESOLVED",
      severity: optEnum(obj, "severity", SEVERITIES),
      sort: optEnum(obj, "sort", SORTS) ?? "severity",
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const where = {
      ...(args.status === "UNRESOLVED" ? { status: { not: ComplaintStatus.RESOLVED } } : { status: args.status as ComplaintStatus }),
      ...(args.severity ? { severity: args.severity } : {}),
    };
    const orderBy =
      args.sort === "oldest" ? [{ createdAt: "asc" as const }]
      : args.sort === "newest" ? [{ createdAt: "desc" as const }]
      : [{ severity: "desc" as const }, { createdAt: "asc" as const }];
    const [total, groups, complaints] = await Promise.all([
      ctx.tenantPrisma.complaint.count({ where }),
      ctx.tenantPrisma.complaint.groupBy({ by: ["severity", "technicianId", "upheld"], where, _count: true }),
      ctx.tenantPrisma.complaint.findMany({
        where,
        select: {
          title: true,
          severity: true,
          status: true,
          createdAt: true,
          revisitDate: true,
          issueType: true,
          upheld: true,
          resolvedAt: true,
          customer: { select: { name: true } },
          property: { select: { addressLine: true } },
          technician: { select: { name: true } },
        },
        orderBy,
        take: args.limit,
      }),
    ]);
    const rows: ResultRow[] = complaints.map((c) => {
      const logged = localDayOf(c.createdAt, clock.tz);
      const resolvedDay = c.resolvedAt ? localDayOf(c.resolvedAt, clock.tz) : null;
      return {
        customer: c.customer.name,
        address: c.property?.addressLine ?? null,
        title: c.title,
        severity: c.severity,
        status: c.status,
        technician: c.technician?.name ?? null,
        ageDays: Math.max(0, daysBetween(logged, clock.today)),
        logged,
        revisitDate: c.revisitDate ? c.revisitDate.toISOString().slice(0, 10) : null,
        issueType: c.issueType ?? null,
        upheld: c.upheld === true ? "Upheld" : c.upheld === false ? "Not upheld" : null,
        resolvedAt: resolvedDay,
        daysToResolve: resolvedDay ? Math.max(0, daysBetween(logged, resolvedDay)) : null,
      };
    });
    const severity = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    const byTechId = new Map<string | null, number>();
    let upheld = 0;
    let notUpheld = 0;
    for (const g of groups) {
      const n = g._count as unknown as number;
      if (g.severity in severity) severity[g.severity as keyof typeof severity] += n;
      byTechId.set(g.technicianId, (byTechId.get(g.technicianId) ?? 0) + n);
      if (g.upheld === true) upheld += n;
      else if (g.upheld === false) notUpheld += n;
    }
    const techIds = [...byTechId.keys()].filter((id): id is string => id !== null);
    const techs = techIds.length === 0 ? [] : await ctx.tenantPrisma.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true } });
    const techName = new Map(techs.map((t) => [t.id, t.name ?? "Unnamed technician"]));
    const byTechnician = new Map<string, number>();
    for (const [id, n] of byTechId) {
      const name = id === null ? "Unassigned" : techName.get(id) ?? "Unknown technician";
      byTechnician.set(name, (byTechnician.get(name) ?? 0) + n);
    }
    const top = topEntry(new Map([...byTechnician].filter(([name]) => name !== "Unassigned")));
    return {
      dateRange: null,
      rows,
      totals: total === 0 ? null : {
        customer: "Total",
        complaints: total,
        highCount: severity.HIGH,
        mediumCount: severity.MEDIUM,
        lowCount: severity.LOW,
        upheldCount: upheld,
        notUpheldCount: notUpheld,
        upheldRate: pct(upheld, upheld + notUpheld),
        byTechnician: breakdownText(byTechnician),
        topTechnician: top?.name ?? null,
        topTechnicianCount: top?.count ?? null,
      },
      truncated: total > rows.length,
      columns: COLUMNS,
    };
  },
};
