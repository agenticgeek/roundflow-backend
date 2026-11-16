import { PaymentMethod, PaymentStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, instantRange, localDayOf, optDate, optEnum, parseArgs, parseLimit, pct, resolveRange, round2, tenantClock, toDateRange } from "./shared";

// list_payments(status?, method?, from?, to?, limit?): payments created in a date range. Only the fixed columns below
// are returned; provider ids, receipt URLs and references are never selected. The headline totals (collection rate,
// paid, failed, by method) come from one groupBy over every match, so they are exact even when the list is capped.

const STATUSES = Object.values(PaymentStatus) as PaymentStatus[];
const METHODS = Object.values(PaymentMethod) as PaymentMethod[];

interface Args {
  status?: PaymentStatus;
  method?: PaymentMethod;
  from?: string;
  to?: string;
  limit: number;
}

/** Not yet due or cancelled payments are not "due" money, so they stay out of the collection rate. */
const NOT_DUE_STATUSES: readonly string[] = [PaymentStatus.NOT_DUE, PaymentStatus.CANCELLED];

const COLUMNS = columns(
  ["date", "Date", "date"],
  ["customer", "Customer", "text"],
  ["amount", "Amount", "currency"],
  ["method", "Method", "text"],
  ["status", "Status", "text"]
);

export const listPayments: ToolDefinition<Args> = {
  name: "list_payments",
  label: "Payments",
  readOnly: true,
  description:
    "Payments created in a date range (YYYY-MM-DD inclusive, max 366 days; default: this month so far), newest first, with amount in pounds, method and status. Filter by status (e.g. FAILED, OVERDUE, PAID) and method (GOCARDLESS, STRIPE, CASH, CHEQUE, BACS). Totals cover every match, not just the rows shown. " +
    "Use for 'how much did we collect this month', 'how many direct debits failed' and 'what share of payments by card'. " +
    "Do NOT use for money still owed by customers (use list_debtors), for invoice status (use list_invoices) or for revenue earned from visits (use revenue_summary). " +
    "Example: {\"status\":\"FAILED\",\"from\":\"2026-10-01\",\"to\":\"2026-10-31\"}. " +
    "Totals: amount and payments = everything matched; paidAmount/paidCount, failedAmount/failedCount; dueAmount = all matched except NOT_DUE and CANCELLED; collectionRate = paidAmount / dueAmount as a percentage (null when nothing is due); " +
    "gocardlessAmount/gocardlessCount, stripeAmount/stripeCount, cashAmount/cashCount, chequeAmount/chequeCount, bacsAmount/bacsCount = split by method.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUSES },
      method: { type: "string", enum: METHODS },
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["status", "method", "from", "to", "limit"]);
    return {
      status: optEnum(obj, "status", STATUSES),
      method: optEnum(obj, "method", METHODS),
      from: optDate(obj, "from"),
      to: optDate(obj, "to"),
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const where = {
      createdAt: instantRange(clock.tz, from, to),
      ...(args.status ? { status: args.status } : {}),
      ...(args.method ? { method: args.method } : {}),
    };
    const [payments, groups] = await Promise.all([
      ctx.tenantPrisma.payment.findMany({
        where,
        select: { createdAt: true, amount: true, method: true, status: true, customer: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: args.limit + 1,
      }),
      ctx.tenantPrisma.payment.groupBy({ by: ["status", "method"], where, _count: true, _sum: { amount: true } }),
    ]);
    const rows: ResultRow[] = payments.slice(0, args.limit).map((p) => ({
      date: localDayOf(p.createdAt, clock.tz),
      customer: p.customer.name,
      amount: round2(Number(p.amount)),
      method: p.method,
      status: p.status,
    }));
    const count = groups.reduce((n, g) => n + (g._count as unknown as number), 0);
    let paidAmount = 0;
    let paidCount = 0;
    let failedAmount = 0;
    let failedCount = 0;
    let dueAmount = 0;
    const byMethod = new Map<string, { amount: number; count: number }>();
    for (const g of groups) {
      const n = g._count as unknown as number;
      const amount = Number(g._sum.amount ?? 0);
      if (g.status === PaymentStatus.PAID) {
        paidAmount += amount;
        paidCount += n;
      } else if (g.status === PaymentStatus.FAILED) {
        failedAmount += amount;
        failedCount += n;
      }
      if (!NOT_DUE_STATUSES.includes(g.status)) dueAmount += amount;
      const m = byMethod.get(g.method) ?? { amount: 0, count: 0 };
      m.amount += amount;
      m.count += n;
      byMethod.set(g.method, m);
    }
    const methodTotals: ResultRow = {};
    for (const m of METHODS) {
      const v = byMethod.get(m) ?? { amount: 0, count: 0 };
      methodTotals[`${m.toLowerCase()}Amount`] = round2(v.amount);
      methodTotals[`${m.toLowerCase()}Count`] = v.count;
    }
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: count === 0 ? null : {
        date: null,
        customer: "Total",
        amount: round2(groups.reduce((n, g) => n + Number(g._sum.amount ?? 0), 0)),
        method: null,
        status: null,
        payments: count,
        paidAmount: round2(paidAmount),
        paidCount,
        failedAmount: round2(failedAmount),
        failedCount,
        dueAmount: round2(dueAmount),
        collectionRate: pct(paidAmount, dueAmount),
        ...methodTotals,
      },
      truncated: payments.length > args.limit,
      columns: COLUMNS,
    };
  },
};
