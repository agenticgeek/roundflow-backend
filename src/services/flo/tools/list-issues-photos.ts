import { PhotoReviewStatus, PhotoType } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { columns, instantRange, localDayOf, optDate, parseArgs, parseLimit, resolveRange, tenantClock, toDateRange } from "./shared";
import { humanize } from "./e2-helpers";

// list_issues_photos(from?, to?, limit?): problems technicians raised in the field (Issue.type) over a range, with the
// most recent ones, and the photo queue. The free-text issue note and photo URLs are never selected.
//
// The schema has no "damage" photo type: PhotoType is PROPERTY, BEFORE, AFTER or ACCESS_ISSUE. So instead of a damage
// photo count this reports photos attached to field issues (ACCESS_ISSUE) and photos attached to complaints (the
// evidence behind damage claims), both counted by upload date in the range.

interface Args {
  from?: string;
  to?: string;
  limit: number;
}

const COLUMNS = columns(
  ["kind", "Row type", "text"],
  ["label", "Issue type / photo group", "text"],
  ["count", "Count", "integer"],
  ["date", "Date", "date"],
  ["customer", "Customer", "text"],
  ["address", "Address", "text"]
);

const blank = { label: null, count: null, date: null, customer: null, address: null };

export const listIssuesPhotos: ToolDefinition<Args> = {
  name: "list_issues_photos",
  label: "Field issues and photos",
  readOnly: true,
  description:
    "Problems technicians raised in the field over a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far): counts by issue type (access problem, gate locked, payment issue, dog loose, no rear access, unsafe conditions, wrong address, other), the most recent issues (type, date, customer, address; never the note text), photos waiting for review, photos attached to access issues and photos attached to complaints. Use for 'what problems did technicians report', 'how many access problems', 'are photos waiting for review'. Do not use for customer complaints (list_complaints) or skipped visits (list_skipped_visits). There is no separate damage-photo type: damage evidence is the complaint photos count. Example: {\"from\":\"2026-11-01\",\"limit\":10}. Glossary: row type 'Issues by type' = count per type; 'Recent issue' = one raised issue; 'Photos' = photo counts (awaiting review is the current queue, not limited to the range). Total count = all issues raised in the range.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      limit: { type: "integer", description: "Max recent issues listed, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const createdAt = instantRange(clock.tz, from, to);
    const propertySelect = { select: { addressLine: true, customer: { select: { name: true } } } } as const;

    const [byType, recent, pending, accessPhotos, complaintPhotos] = await Promise.all([
      tp.issue.groupBy({ by: ["type"], where: { createdAt }, _count: true }),
      tp.issue.findMany({
        where: { createdAt },
        select: { type: true, createdAt: true, property: propertySelect, visit: { select: { property: propertySelect } } },
        orderBy: { createdAt: "desc" },
        take: args.limit + 1,
      }),
      tp.photo.count({ where: { reviewStatus: PhotoReviewStatus.PENDING } }),
      tp.photo.count({ where: { type: PhotoType.ACCESS_ISSUE, createdAt } }),
      tp.photo.count({ where: { complaintId: { not: null }, createdAt } }),
    ]);

    const types = [...byType].sort((a, b) => b._count - a._count || a.type.localeCompare(b.type));
    const shown = recent.slice(0, args.limit);
    const rows: ResultRow[] = [
      ...types.map((t): ResultRow => ({ kind: "Issues by type", ...blank, label: humanize(t.type), count: t._count })),
      ...shown.map((i): ResultRow => {
        const p = i.property ?? i.visit.property;
        return { kind: "Recent issue", ...blank, label: humanize(i.type), date: localDayOf(i.createdAt, clock.tz), customer: p.customer.name, address: p.addressLine };
      }),
      { kind: "Photos", ...blank, label: "Awaiting review", count: pending },
      { kind: "Photos", ...blank, label: "Attached to access issues", count: accessPhotos },
      { kind: "Photos", ...blank, label: "Attached to complaints", count: complaintPhotos },
    ];
    const total = types.reduce((n, t) => n + t._count, 0);
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: { kind: "Total", label: null, count: total, date: null, customer: null, address: null },
      truncated: recent.length > shown.length,
      columns: COLUMNS,
    };
  },
};
