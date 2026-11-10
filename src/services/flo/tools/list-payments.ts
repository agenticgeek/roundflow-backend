import { PaymentMethod, PaymentStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, instantRange, localDayOf, optDate, optEnum, parseArgs, parseLimit, resolveRange, round2, tenantClock, toDateRange } from "./shared";

// list_payments(status?, method?, from?, to?, limit?): payments created in a date range. Only the fixed columns below
// are returned; provider ids, receipt URLs and references are never selected.

const STATUSES = Object.values(PaymentStatus) as PaymentStatus[];
const METHODS = Object.values(PaymentMethod) as PaymentMethod[];

interface Args {
  status?: PaymentStatus;
  method?: PaymentMethod;
  from?: string;
  to?: string;
  limit: number;
}

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
    "Payments created in a date range (YYYY-MM-DD inclusive, max 366 days; default: this month so far), newest first, with amount in pounds, method and status. Filter by status (e.g. FAILED, OVERDUE, PAID) and method (GOCARDLESS, STRIPE, CASH, CHEQUE, BACS). Totals cover every match, not just the rows shown.",
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
      ctx.tenantPrisma.payment.groupBy({ by: ["status"], where, _count: true, _sum: { amount: true } }),
    ]);
    const rows: ResultRow[] = payments.slice(0, args.limit).map((p) => ({
      date: localDayOf(p.createdAt, clock.tz),
      customer: p.customer.name,
      amount: round2(Number(p.amount)),
      method: p.method,
      status: p.status,
    }));
    const count = groups.reduce((n, g) => n + (g._count as unknown as number), 0);
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
      },
      truncated: payments.length > args.limit,
      columns: COLUMNS,
    };
  },
};
