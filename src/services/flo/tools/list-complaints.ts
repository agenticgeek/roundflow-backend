import { ComplaintStatus, Severity } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, daysBetween, localDayOf, optEnum, parseArgs, parseLimit, tenantClock } from "./shared";

// list_complaints(status?, severity?, sort?, limit?): the complaints list (same fields as complaint.service) with an
// age in days. Severity ordering and the UNRESOLVED filter are not in complaint.service.listComplaints (it pages by
// newest first and can't sort by severity), so this is one read-only query on the same model.

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
  ["revisitDate", "Revisit", "date"]
);

export const listComplaints: ToolDefinition<Args> = {
  name: "list_complaints",
  label: "Complaints",
  readOnly: true,
  description:
    "Complaints with customer, property, technician, severity, status and age in days. status defaults to UNRESOLVED (anything not resolved); or OPEN, IN_REVIEW, REVISIT_BOOKED, RESOLVED. severity LOW, MEDIUM or HIGH. sort: severity (highest first, then oldest first; the default), oldest, newest. Use for 'open complaints by severity, oldest first'.",
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
    const [total, complaints] = await Promise.all([
      ctx.tenantPrisma.complaint.count({ where }),
      ctx.tenantPrisma.complaint.findMany({
        where,
        select: {
          title: true,
          severity: true,
          status: true,
          createdAt: true,
          revisitDate: true,
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
      };
    });
    return {
      dateRange: null,
      rows,
      totals: total === 0 ? null : { customer: "Total", complaints: total },
      truncated: total > rows.length,
      columns: COLUMNS,
    };
  },
};
