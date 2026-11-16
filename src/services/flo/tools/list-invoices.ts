import { InvoiceStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { countOf, num, optBool } from "./e1-helpers";
import { checkRange, columns, dateToDay, dayToDate, daysBetween, instantRange, localDayOf, optDate, optEnum, parseArgs, parseLimit, round2, tenantClock, toDateRange } from "./shared";

// list_invoices(status?, notSentToCustomer?, overdueOnly?, from?, to?, limit?): invoices by status with exact totals per
// status from a groupBy (so the headline numbers stay exact when the list is capped).

const STATUSES = [InvoiceStatus.DRAFT, InvoiceStatus.SENT, InvoiceStatus.PAID, InvoiceStatus.VOID] as const;

interface Args {
  status?: (typeof STATUSES)[number];
  notSentToCustomer: boolean;
  overdueOnly: boolean;
  from?: string;
  to?: string;
  limit: number;
}

const COLUMNS = columns(
  ["invoiceNumber", "Invoice", "text"],
  ["customer", "Customer", "text"],
  ["amount", "Amount", "currency"],
  ["status", "Status", "text"],
  ["dueDate", "Due date", "date"],
  ["daysOverdue", "Days overdue", "integer"],
  ["sentToCustomer", "Sent to customer", "text"],
  ["paidAt", "Paid on", "date"]
);

export const listInvoices: ToolDefinition<Args> = {
  name: "list_invoices",
  label: "Invoices",
  readOnly: true,
  description:
    "Invoices with their status (DRAFT = not yet sent, SENT = sent and unpaid, PAID, VOID), amount in pounds, due date, days overdue and whether the customer has actually been sent it. Oldest due first. Totals give the count and value per status for ALL matching invoices (exact even when the list is capped). " +
    "Filters: status; notSentToCustomer=true (invoices the customer has not received yet); overdueOnly=true (SENT and past the due date); from/to (YYYY-MM-DD, by the day the invoice was created, max 366 days; from defaults to the first of the month of to, to defaults to today); limit 1 to 200 (default 50). " +
    "Use for 'how many invoices are still draft', 'which invoices are sent but unpaid', 'what hasn't been sent to customers'. Use list_debtors instead for who owes money per customer. Example: {\"overdueOnly\": true}. " +
    "Fields: amount (pounds), daysOverdue (only for SENT invoices past their due date), sentToCustomer (Yes/No), paidAt (tenant-local date). Totals: invoices/amount overall plus draftCount/draftAmount, sentCount/sentAmount, paidCount/paidAmount, voidCount/voidAmount.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...STATUSES], description: "Only invoices in this status" },
      notSentToCustomer: { type: "boolean", description: "Only invoices not yet sent to the customer" },
      overdueOnly: { type: "boolean", description: "Only SENT invoices whose due date has passed" },
      from: { type: "string", description: "YYYY-MM-DD, invoices created on or after" },
      to: { type: "string", description: "YYYY-MM-DD, invoices created on or before" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["status", "notSentToCustomer", "overdueOnly", "from", "to", "limit"]);
    return {
      status: optEnum(obj, "status", STATUSES),
      notSentToCustomer: optBool(obj, "notSentToCustomer") ?? false,
      overdueOnly: optBool(obj, "overdueOnly") ?? false,
      from: optDate(obj, "from"),
      to: optDate(obj, "to"),
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const to = args.to ?? clock.today;
    const range = args.from || args.to ? checkRange(args.from ?? `${to.slice(0, 8)}01`, to) : null;
    if (args.overdueOnly && args.status && args.status !== InvoiceStatus.SENT) {
      return { dateRange: null, rows: [], totals: null, truncated: false, columns: COLUMNS };
    }
    const where = {
      ...(args.overdueOnly ? { status: InvoiceStatus.SENT, dueDate: { lt: dayToDate(clock.today) } } : args.status ? { status: args.status } : {}),
      ...(args.notSentToCustomer ? { sentToCustomer: false } : {}),
      ...(range ? { createdAt: instantRange(clock.tz, range.from, range.to) } : {}),
    };
    const [invoices, groups] = await Promise.all([
      ctx.tenantPrisma.invoice.findMany({
        where,
        select: {
          invoiceNumber: true, amount: true, status: true, dueDate: true, sentToCustomer: true, paidAt: true,
          customer: { select: { name: true } },
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: args.limit + 1,
      }),
      ctx.tenantPrisma.invoice.groupBy({ by: ["status"], where, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    const rows: ResultRow[] = invoices.slice(0, args.limit).map((i) => {
      const due = i.dueDate ? dateToDay(i.dueDate) : null;
      return {
        invoiceNumber: i.invoiceNumber,
        customer: i.customer.name,
        amount: round2(num(i.amount)),
        status: i.status,
        dueDate: due,
        daysOverdue: i.status === InvoiceStatus.SENT && due ? Math.max(0, daysBetween(due, clock.today)) : null,
        sentToCustomer: i.sentToCustomer ? "Yes" : "No",
        paidAt: i.paidAt ? localDayOf(i.paidAt, clock.tz) : null,
      };
    });

    const byStatus = new Map(groups.map((g) => [g.status as string, { count: countOf(g._count), amount: num(g._sum.amount) }]));
    const part = (s: string) => byStatus.get(s) ?? { count: 0, amount: 0 };
    const totalCount = groups.reduce((n, g) => n + countOf(g._count), 0);
    const totalAmount = groups.reduce((n, g) => n + num(g._sum.amount), 0);
    return {
      dateRange: range ? toDateRange(range.from, range.to) : null,
      rows,
      totals: totalCount === 0 ? null : {
        invoiceNumber: "Total",
        customer: null,
        amount: round2(totalAmount),
        status: null,
        dueDate: null,
        daysOverdue: null,
        sentToCustomer: null,
        paidAt: null,
        invoices: totalCount,
        draftCount: part("DRAFT").count, draftAmount: round2(part("DRAFT").amount),
        sentCount: part("SENT").count, sentAmount: round2(part("SENT").amount),
        paidCount: part("PAID").count, paidAmount: round2(part("PAID").amount),
        voidCount: part("VOID").count, voidAmount: round2(part("VOID").amount),
      },
      truncated: invoices.length > args.limit,
      columns: COLUMNS,
    };
  },
};
