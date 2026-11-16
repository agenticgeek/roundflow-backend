import { createDebtService, DEBT_BUCKETS } from "../../debt.service";
import { NOT_COLLECTING_INVOICE } from "../../direct-debit";
import type { ResultRow, ToolDefinition } from "../types";
import { columns, daysBetween, dateToDay, optEnum, optNumber, optInt, parseArgs, parseLimit, pct, round2, tenantClock } from "./shared";

// list_debtors(minBalance?, minDaysOverdue?, bucket?, limit?): customers with unpaid SENT invoices, built on
// debt.service.getBoard (the same buckets as the Debt screen). Balances are summed per customer.
// O4: with no filter the headline totals (total owed, customers, invoices, aging buckets, shares, average days overdue)
// come from database aggregates over EVERY unpaid sent invoice, so they are exact even when the list is capped. With a
// bucket / minBalance / minDaysOverdue filter the totals describe the scanned, filtered customers and `truncated` says
// when the scan did not cover everything.

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

/** One slice of debt: `amount` pounds across `n` invoices that fall due on `due` (null = no due date). */
interface Slice {
  amount: number;
  n: number;
  due: string | null;
}

interface Agg {
  customer: string;
  address: string;
  slices: Slice[];
  balance: number;
  invoices: number;
  oldestDue: string | null;
  paymentMethod: string | null;
  badDebt: boolean;
  hold: boolean;
}

/** Aging totals. Days overdue = tenant-local today minus the due date; due today or later (or no due date) is "not overdue". */
function agingTotals(slices: Slice[], today: string): ResultRow {
  const bucket = { notOverdue: 0, d1to30: 0, d31to60: 0, d61to90: 0, over90: 0 };
  let overdueInvoices = 0;
  let overdueDays = 0;
  for (const s of slices) {
    const d = s.due ? daysBetween(s.due, today) : 0;
    if (d <= 0) bucket.notOverdue += s.amount;
    else if (d <= 30) bucket.d1to30 += s.amount;
    else if (d <= 60) bucket.d31to60 += s.amount;
    else if (d <= 90) bucket.d61to90 += s.amount;
    else bucket.over90 += s.amount;
    if (d > 0) {
      overdueInvoices += s.n;
      overdueDays += d * s.n;
    }
  }
  const total = slices.reduce((n, s) => n + s.amount, 0);
  return {
    avgDaysOverdue: overdueInvoices === 0 ? null : Math.round(overdueDays / overdueInvoices),
    balanceNotOverdue: round2(bucket.notOverdue),
    balance1To30: round2(bucket.d1to30),
    balance31To60: round2(bucket.d31to60),
    balance61To90: round2(bucket.d61to90),
    balanceOver90: round2(bucket.over90),
    shareOver30: pct(bucket.d31to60 + bucket.d61to90 + bucket.over90, total),
    shareOver60: pct(bucket.d61to90 + bucket.over90, total),
  };
}

export const listDebtors: ToolDefinition<Args> = {
  name: "list_debtors",
  label: "Debt",
  readOnly: true,
  description:
    "Customers who owe money (unpaid sent invoices), largest balance first, with balance in pounds, number of invoices and days overdue. Optional filters: minBalance (pounds), minDaysOverdue, bucket (BAD_DEBT, ON_HOLD, FAILED_GC, DUE_BEFORE_CLEAN, SEVEN_DAYS_OVER, FOURTEEN_DAYS_OVER, ALL). Use for 'who owes me more than 50 pounds and for how long' and 'how much is overdue by more than 30 days'. " +
    "Do NOT use for payments taken or failed (use list_payments), for invoices by status such as draft or not yet sent (use list_invoices), or for one named customer's balance (use get_customer_summary). " +
    "Example: {\"minBalance\":50,\"minDaysOverdue\":30,\"limit\":10}. " +
    "Totals (exact over all unpaid sent invoices when no filter is given): balance = total owed, customers, invoices, balanceNotOverdue / balance1To30 / balance31To60 / balance61To90 / balanceOver90 = pounds by days past due date, " +
    "shareOver30 and shareOver60 = percentage of the balance more than 30 or 60 days past due, avgDaysOverdue = mean days past due over overdue invoices (null when none). " +
    "Rows: daysOverdue = days since the customer's oldest unpaid invoice was due. Invoices being collected by direct debit are not counted as debt. With a filter the totals cover only the matching scanned customers.",
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
    const tp = ctx.tenantPrisma;
    const board = createDebtService(tp);
    const buckets = args.bucket ? [args.bucket] : DEFAULT_BUCKETS;
    const unfiltered = args.bucket === undefined && args.minBalance === undefined && args.minDaysOverdue === undefined;
    const unpaid = { status: "SENT" as const, ...NOT_COLLECTING_INVOICE };
    const exactPromise = unfiltered
      ? Promise.all([
          tp.invoice.groupBy({ by: ["dueDate"], where: unpaid, _sum: { amount: true }, _count: true }),
          tp.customer.count({ where: { invoices: { some: unpaid } } }),
        ])
      : null;
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
            slices: [],
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
          a.slices.push({ amount: row.amount, n: row.invoiceId ? 1 : 0, due });
          if (due && (a.oldestDue === null || due < a.oldestDue)) a.oldestDue = due;
        }
        if (page >= res.pagination.totalPages) break;
        if (page === MAX_PAGES) truncated = true;
      }
    }
    const passing = [...byCustomer.values()]
      .map((a) => ({
        a,
        row: {
          customer: a.customer,
          address: a.address,
          balance: round2(a.balance),
          invoices: a.invoices,
          daysOverdue: a.oldestDue ? Math.max(0, daysBetween(a.oldestDue, clock.today)) : 0,
          oldestDueDate: a.oldestDue,
          paymentMethod: a.paymentMethod,
          flag: a.badDebt ? "Bad debt" : a.hold ? "On hold" : null,
        } as ResultRow,
      }))
      .filter(({ row }) => (args.minBalance === undefined || (row.balance as number) >= args.minBalance) && (args.minDaysOverdue === undefined || (row.daysOverdue as number) >= args.minDaysOverdue))
      .sort((x, y) => (y.row.balance as number) - (x.row.balance as number) || (x.row.customer as string).localeCompare(y.row.customer as string));
    const all = passing.map((p) => p.row);
    const rows = all.slice(0, args.limit);

    // Exact headline figures from the database when unfiltered (and the database has any debt); otherwise the scanned set.
    const [dueGroups, customerCount] = exactPromise ? await exactPromise : [[], 0];
    const exactInvoices = dueGroups.reduce((n, g) => n + (g._count as unknown as number), 0);
    const exact = exactInvoices > 0;
    const slices: Slice[] = exact
      ? dueGroups.map((g) => ({ amount: Number(g._sum.amount ?? 0), n: g._count as unknown as number, due: g.dueDate ? dateToDay(g.dueDate) : null }))
      : passing.flatMap((p) => p.a.slices);
    const customers = exact ? customerCount : all.length;
    const totals: ResultRow | null =
      !exact && all.length === 0 ? null : {
        customer: "Total",
        customers,
        address: null,
        balance: round2(slices.reduce((n, s) => n + s.amount, 0)),
        invoices: exact ? exactInvoices : all.reduce((n, r) => n + (r.invoices as number), 0),
        daysOverdue: null,
        oldestDueDate: null,
        paymentMethod: null,
        flag: null,
        ...agingTotals(slices, clock.today),
      };
    return {
      dateRange: null,
      rows,
      totals,
      truncated: truncated || customers > rows.length,
      columns: COLUMNS,
    };
  },
};
