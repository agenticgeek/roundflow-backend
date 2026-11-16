import { InvoiceStatus, VisitStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { countOf, num } from "./e1-helpers";
import { columns, optDate, parseArgs, resolveRange, round2, tenantClock, toDateRange, visitDateWhere } from "./shared";

// revenue_leakage(from?, to?): where money is lost or stuck, one row per category. Everything is an aggregate over
// Visit (by visit date), so the figures are exact and there is no scan cap. Categories do not overlap: a carried-over
// visit is counted only as carried over, and payment-hold excludes carried-over visits; price adjustments measure the
// difference (original - charged) on completed visits, not the visit value.

interface Args {
  from?: string;
  to?: string;
}

const COLUMNS = columns(
  ["category", "Category", "text"],
  ["visits", "Visits", "integer"],
  ["value", "Value", "currency"],
  ["detail", "Detail", "text"]
);

const OPEN = [VisitStatus.SCHEDULED, VisitStatus.IN_PROGRESS];

export const revenueLeakage: ToolDefinition<Args> = {
  name: "revenue_leakage",
  label: "Revenue leakage",
  readOnly: true,
  description:
    "Where money is being lost or is stuck, for a date range (YYYY-MM-DD inclusive, max 366 days, default this month so far), one row per category with visit count and value in pounds: price adjustments (discount given: original price minus price charged, with the most common reasons), skipped visits (value not earned), carried-over visits (value pushed back), completed but not invoiced, completed and invoice sent but unpaid, and visits on payment hold. " +
    "Totals = total at stake (categories do not overlap, so they can be added). " +
    "Use for 'where am I losing money', 'what have I not invoiced', 'what is stuck', 'how much have discounts cost me'. Use list_debtors for who owes money and revenue_summary for revenue earned. Example: {\"from\":\"2026-10-01\",\"to\":\"2026-10-31\"}. " +
    "Fields: visits (count), value (pounds), detail (short explanation, for price adjustments the top reasons). Dates are by visit date.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to") };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const tp = ctx.tenantPrisma;
    const date = visitDateWhere(from, to);
    const agg = (where: Record<string, unknown>) => tp.visit.aggregate({ where: { date, ...where }, _sum: { price: true }, _count: { _all: true } });

    const [adjusted, reasons, skipped, carried, uninvoiced, unpaid, held] = await Promise.all([
      tp.visit.aggregate({ where: { date, status: VisitStatus.COMPLETED, originalPrice: { not: null } }, _sum: { price: true, originalPrice: true }, _count: { _all: true } }),
      tp.visit.groupBy({ by: ["priceAdjustmentReason"], where: { date, status: VisitStatus.COMPLETED, originalPrice: { not: null } }, _count: { _all: true } }),
      agg({ status: VisitStatus.SKIPPED }),
      agg({ status: { in: OPEN }, carryoverCount: { gt: 0 } }),
      agg({ status: VisitStatus.COMPLETED, invoice: { is: null } }),
      agg({ status: VisitStatus.COMPLETED, invoice: { is: { status: InvoiceStatus.SENT } } }),
      agg({ status: { in: OPEN }, paymentHold: true, carryoverCount: 0 }),
    ]);

    const topReasons = reasons
      .map((r) => ({ reason: r.priceAdjustmentReason ?? "No reason given", n: countOf(r._count) }))
      .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason))
      .slice(0, 3)
      .map((r) => `${r.reason} (${r.n})`)
      .join(", ");

    const rows: ResultRow[] = [
      { category: "Price adjustments (discounts given)", visits: countOf(adjusted._count), value: round2(num(adjusted._sum.originalPrice) - num(adjusted._sum.price)), detail: topReasons || null },
      { category: "Skipped visits", visits: countOf(skipped._count), value: round2(num(skipped._sum.price)), detail: "Value of visits skipped, not earned" },
      { category: "Carried over", visits: countOf(carried._count), value: round2(num(carried._sum.price)), detail: "Visits moved to a later day and not yet done" },
      { category: "Completed, not invoiced", visits: countOf(uninvoiced._count), value: round2(num(uninvoiced._sum.price)), detail: "Done but no invoice exists" },
      { category: "Completed, unpaid", visits: countOf(unpaid._count), value: round2(num(unpaid._sum.price)), detail: "Invoice sent, not yet paid" },
      { category: "Payment hold", visits: countOf(held._count), value: round2(num(held._sum.price)), detail: "Open visits held for payment" },
    ];
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: {
        category: "Total at stake",
        visits: rows.reduce((n, r) => n + (r.visits as number), 0),
        value: round2(rows.reduce((n, r) => n + (r.value as number), 0)),
        detail: null,
      },
      truncated: false,
      columns: COLUMNS,
    };
  },
};
