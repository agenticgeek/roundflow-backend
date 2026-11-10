import { VisitStatus } from "../../../generated/tenant-client";
import { NOT_COLLECTING_INVOICE } from "../../direct-debit";
import type { ResultRow, ToolDefinition } from "../types";
import { addDays, columns, dateToDay, daysBetween, MAX_QUERY_CHARS, parseArgs, reqString, round2, tenantClock } from "./shared";

// get_customer_summary(query): "What does Mrs Smith owe?". Looks a customer up by name (honorifics ignored, every word
// must match) or by part of an address. Up to 5 matches: with more than one match it returns a disambiguation list
// (name, address line 1, id) instead of guessing. The id is a tenant record id, never a secret.

interface Args {
  query: string;
}

const MAX_MATCHES = 5;
const SKIP_WINDOW_DAYS = 90;
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "sir", "madam"]);

const SUMMARY = columns(
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["balance", "Balance owed", "currency"],
  ["invoices", "Unpaid invoices", "integer"],
  ["daysOverdue", "Days overdue", "integer"],
  ["lastClean", "Last clean", "date"],
  ["nextClean", "Next clean", "date"],
  ["recentSkips", "Skips (last 90 days)", "integer"],
  ["status", "Account status", "text"]
);
const CHOICES = columns(["customer", "Customer", "text"], ["address", "Address", "text"], ["id", "Customer id", "text"]);

export const getCustomerSummary: ToolDefinition<Args> = {
  name: "get_customer_summary",
  label: "Customer",
  readOnly: true,
  description:
    "Look up one customer by name or address and return their balance owed (pounds), days overdue, last clean, next clean and recent skips. If several customers match (up to 5) it returns a list to choose from instead of guessing; ask the user which one. Use for 'what does Mrs Smith owe?'.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Customer name or part of the address, up to 80 characters" } },
    required: ["query"],
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["query"]);
    return { query: reqString(obj, "query", MAX_QUERY_CHARS) };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const tp = ctx.tenantPrisma;
    const tokens = args.query.split(/\s+/).filter((t) => t !== "" && !HONORIFICS.has(t.toLowerCase().replace(/\.$/, "")));
    const nameClause = tokens.length > 0 ? [{ AND: tokens.map((t) => ({ name: { contains: t, mode: "insensitive" as const } })) }] : [];
    const found = await tp.customer.findMany({
      where: { OR: [...nameClause, { properties: { some: { addressLine: { contains: args.query, mode: "insensitive" } } } }] },
      select: { id: true, name: true, status: true, properties: { select: { addressLine: true }, orderBy: { createdAt: "asc" }, take: 1 } },
      orderBy: { name: "asc" },
      take: MAX_MATCHES + 1,
    });
    const matches = found.slice(0, MAX_MATCHES);
    if (matches.length !== 1) {
      const rows: ResultRow[] = matches.map((c) => ({ customer: c.name, address: c.properties[0]?.addressLine ?? null, id: c.id }));
      return { dateRange: null, rows, totals: { customer: "Total", matches: matches.length }, truncated: found.length > MAX_MATCHES, columns: CHOICES };
    }

    const c = matches[0];
    const skipSince = addDays(clock.today, -SKIP_WINDOW_DAYS);
    const [invoices, last, next, skips] = await Promise.all([
      tp.invoice.findMany({ where: { customerId: c.id, status: "SENT", ...NOT_COLLECTING_INVOICE }, select: { amount: true, dueDate: true } }),
      tp.visit.findFirst({ where: { property: { customerId: c.id }, status: VisitStatus.COMPLETED }, orderBy: { date: "desc" }, select: { date: true } }),
      tp.visit.findFirst({
        where: { property: { customerId: c.id }, status: VisitStatus.SCHEDULED, date: { gte: new Date(`${clock.today}T00:00:00.000Z`) } },
        orderBy: { date: "asc" },
        select: { date: true },
      }),
      tp.visit.count({
        where: { property: { customerId: c.id }, status: VisitStatus.SKIPPED, date: { gte: new Date(`${skipSince}T00:00:00.000Z`) } },
      }),
    ]);
    const dues = invoices.map((i) => i.dueDate).filter((d): d is Date => d !== null).map(dateToDay).sort();
    const row: ResultRow = {
      customer: c.name,
      address: c.properties[0]?.addressLine ?? null,
      balance: round2(invoices.reduce((n, i) => n + Number(i.amount), 0)),
      invoices: invoices.length,
      daysOverdue: dues.length > 0 ? Math.max(0, daysBetween(dues[0], clock.today)) : 0,
      lastClean: last ? dateToDay(last.date) : null,
      nextClean: next ? dateToDay(next.date) : null,
      recentSkips: skips,
      status: c.status,
    };
    return { dateRange: null, rows: [row], totals: null, truncated: false, columns: SUMMARY };
  },
};
