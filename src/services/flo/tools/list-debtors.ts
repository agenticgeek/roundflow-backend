import { createDebtService, DEBT_BUCKETS } from "../../debt.service";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, daysBetween, dateToDay, optEnum, optNumber, optInt, parseArgs, parseLimit, round2, tenantClock } from "./shared";

// list_debtors(minBalance?, minDaysOverdue?, bucket?, limit?): customers with unpaid SENT invoices, built on
// debt.service.getBoard (the same buckets as the Debt screen). Balances are summed per customer.

interface Args {
  minBalance?: number;
  minDaysOverdue?: number;
  bucket?: (typeof DEBT_BUCKETS)[number];
  limit: number;
}

/** Page size of the board and how many pages per bucket are scanned (keeps a single question bounded). */
const BOARD_PAGE_SIZE = 100;
const MAX_PAGES = 2;
/** Without a bucket every invoice bucket is scanned and de-duplicated by invoice (ON_HOLD is customer-level, so it is only used when asked for). */
const DEFAULT_BUCKETS = ["BAD_DEBT", "FAILED_GC", "DUE_BEFORE_CLEAN", "SEVEN_DAYS_OVER", "FOURTEEN_DAYS_OVER", "ALL"] as const;

const COLUMNS = columns(
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["balance", "Balance owed", "currency"],
  ["invoices", "Invoices", "integer"],
  ["daysOverdue", "Days overdue", "integer"],
  ["oldestDueDate", "Oldest due date", "date"],
  ["paymentMethod", "Pays by", "text"],
  ["flag", "Status", "text"]
);

interface Agg {
  customer: string;
  address: string;
  balance: number;
  invoices: number;
  oldestDue: string | null;
  paymentMethod: string | null;
  badDebt: boolean;
  hold: boolean;
}

export const listDebtors: ToolDefinition<Args> = {
  name: "list_debtors",
  label: "Debt",
  readOnly: true,
  description:
    "Customers who owe money (unpaid sent invoices), largest balance first, with balance in pounds, number of invoices and days overdue. Optional filters: minBalance (pounds), minDaysOverdue, bucket (BAD_DEBT, ON_HOLD, FAILED_GC, DUE_BEFORE_CLEAN, SEVEN_DAYS_OVER, FOURTEEN_DAYS_OVER, ALL). Use for 'who owes me more than 50 pounds and for how long'.",
  inputSchema: {
    type: "object",
    properties: {
      minBalance: { type: "number", description: "Only customers owing at least this many pounds" },
      minDaysOverdue: { type: "integer", description: "Only customers whose oldest unpaid invoice is at least this many days past due" },
      bucket: { type: "string", enum: [...DEBT_BUCKETS], description: "Debt board bucket; omit to search all invoice buckets" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["minBalance", "minDaysOverdue", "bucket", "limit"]);
    return {
      minBalance: optNumber(obj, "minBalance", 0, 10_000_000),
      minDaysOverdue: optInt(obj, "minDaysOverdue", 0, 3650),
      bucket: optEnum(obj, "bucket", DEBT_BUCKETS),
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const board = createDebtService(ctx.tenantPrisma);
    const buckets = args.bucket ? [args.bucket] : DEFAULT_BUCKETS;
    const seen = new Set<string>();
    const byCustomer = new Map<string, Agg>();
    let truncated = false;
    for (const bucket of buckets) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await board.getBoard(bucket, undefined, undefined, page, BOARD_PAGE_SIZE);
        for (const row of res.rows) {
          const key = row.invoiceId ?? `customer:${row.customerId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const due = row.dueDate ? dateToDay(row.dueDate) : null;
          const a = byCustomer.get(row.customerId) ?? {
            customer: row.customerName,
            address: row.addressLine,
            balance: 0,
            invoices: 0,
            oldestDue: null,
            paymentMethod: row.paymentMethod,
            badDebt: row.badDebt,
            hold: row.holdNextClean,
          };
          byCustomer.set(row.customerId, a);
          a.balance += row.amount;
          a.invoices += row.invoiceId ? 1 : 0;
          if (due && (a.oldestDue === null || due < a.oldestDue)) a.oldestDue = due;
        }
        if (page >= res.pagination.totalPages) break;
        if (page === MAX_PAGES) truncated = true;
      }
    }
    const all: ResultRow[] = [...byCustomer.values()]
      .map((a) => ({
        customer: a.customer,
        address: a.address,
        balance: round2(a.balance),
        invoices: a.invoices,
        daysOverdue: a.oldestDue ? Math.max(0, daysBetween(a.oldestDue, clock.today)) : 0,
        oldestDueDate: a.oldestDue,
        paymentMethod: a.paymentMethod,
        flag: a.badDebt ? "Bad debt" : a.hold ? "On hold" : null,
      }))
      .filter((r) => (args.minBalance === undefined || (r.balance as number) >= args.minBalance) && (args.minDaysOverdue === undefined || (r.daysOverdue as number) >= args.minDaysOverdue))
      .sort((a, b) => (b.balance as number) - (a.balance as number) || (a.customer as string).localeCompare(b.customer as string));
    const rows = all.slice(0, args.limit);
    return {
      dateRange: null,
      rows,
      totals: all.length === 0 ? null : {
        customer: "Total",
        customers: all.length,
        address: null,
        balance: round2(all.reduce((n, r) => n + (r.balance as number), 0)),
        invoices: all.reduce((n, r) => n + (r.invoices as number), 0),
        daysOverdue: null,
        oldestDueDate: null,
        paymentMethod: null,
        flag: null,
      },
      truncated: truncated || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
