import { ComplaintStatus, InvoiceStatus, PaymentMethod, PaymentStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition } from "../types";
import { countOf, DEFAULT_SKIP_LOOKBACK_DAYS, num, skipStreaks } from "./e1-helpers";
import { addDays, checkRange, columns, dateToDay, daysBetween, instantRange, optDate, optInt, parseArgs, parseLimit, round2, tenantClock, toDateRange } from "./shared";

// list_at_risk_customers(minConsecutiveSkips?, minScore?, since?, limit?): who is about to leave. A composite risk score
// per customer from five signals. With no minScore the list is exactly what it always was (customers whose latest visits
// were skipped minConsecutiveSkips times in a row), now enriched with the score and the other signals. With minScore the
// list is every customer whose score reaches it, whatever the signals.

// ---- risk score constants (points, summed then capped at 100) ----------------------------------------------------------
/** 15 points per skipped visit in a row, at most 45 (3 or more skips in a row). */
export const SKIP_POINTS_EACH = 15;
export const SKIP_POINTS_MAX = 45;
/** 15 points per open (not resolved) complaint, at most 30. */
export const COMPLAINT_POINTS_EACH = 15;
export const COMPLAINT_POINTS_MAX = 30;
/** Overdue sent invoices, by days since the OLDEST unpaid invoice was due: over 60 days 20, over 30 days 15, over 7 days 10, 1 to 7 days 5. */
export const DEBT_POINT_TIERS: ReadonlyArray<{ overDays: number; points: number }> = [
  { overDays: 60, points: 20 },
  { overDays: 30, points: 15 },
  { overDays: 7, points: 10 },
  { overDays: 0, points: 5 },
];
/** A FAILED direct-debit (GoCardless) payment in the last 60 days. */
export const FAILED_DD_POINTS = 15;
export const FAILED_DD_WINDOW_DAYS = 60;
/** Cannot be reached: messages opt-out 5, invalid email address 5. */
export const OPT_OUT_POINTS = 5;
export const EMAIL_INVALID_POINTS = 5;
export const MAX_SCORE = 100;
/** At most this many customers without a skip streak are looked up by name (only used with minScore). */
const MAX_LOOKUPS = 500;

interface Args {
  minConsecutiveSkips: number;
  minScore?: number;
  since?: string;
  limit: number;
}

const COLUMNS = columns(
  ["customer", "Customer", "text"],
  ["address", "Address", "text"],
  ["skips", "Skips in a row", "integer"],
  ["lastSkipped", "Last skipped", "date"],
  ["reason", "Last reason", "text"],
  ["riskScore", "Risk score (0-100)", "integer"],
  ["signals", "Why", "text"],
  ["openComplaints", "Open complaints", "integer"],
  ["balanceOwed", "Balance owed", "currency"],
  ["daysOverdue", "Days overdue", "integer"],
  ["failedDirectDebits", "Failed direct debits (60 days)", "integer"]
);

interface Cust {
  customer: string;
  address: string;
  skips: number;
  lastSkipped: string | null;
  reason: string | null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export const listAtRiskCustomers: ToolDefinition<Args> = {
  name: "list_at_risk_customers",
  label: "At-risk customers",
  readOnly: true,
  description:
    "Customers likely to leave, with a risk score from 0 to 100 and the reasons. Signals: skipped visits in a row (15 points each, max 45), open complaints (15 each, max 30), overdue unpaid invoices (5 to 20 by days overdue), a failed direct debit in the last 60 days (15), cannot be contacted (messages opted out 5, invalid email 5). " +
    "By default it lists customers whose latest visits were skipped several times in a row (minConsecutiveSkips, default 2, 2 to 10) with their score. Give minScore (0 to 100, for example 30) to instead list every customer whose score reaches it, whatever the signals: use that for 'who is about to leave' or 'who should I call'. " +
    "since is YYYY-MM-DD (default 180 days ago, at most 366 days back) and only affects the skip streaks. Use for 'which customers have been skipped twice in a row', 'who is at risk of cancelling'. Use list_debtors for debt only or list_complaints for complaints only. Examples: {} or {\"minScore\":40,\"limit\":10}. " +
    "Fields: skips, lastSkipped, reason (last skip), riskScore (0 to 100), signals (plain-text reasons such as '2 skips in a row; 1 open complaint'), openComplaints, balanceOwed (pounds, sent unpaid invoices), daysOverdue (oldest unpaid), failedDirectDebits.",
  inputSchema: {
    type: "object",
    properties: {
      minConsecutiveSkips: { type: "integer", description: "2 to 10, default 2 (ignored when minScore is given)" },
      minScore: { type: "integer", description: "0 to 100: list every customer whose risk score is at least this" },
      since: { type: "string", description: "YYYY-MM-DD, default 180 days ago" },
      limit: { type: "integer", description: "Max rows, 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["minConsecutiveSkips", "minScore", "since", "limit"]);
    return {
      minConsecutiveSkips: optInt(obj, "minConsecutiveSkips", 2, 10) ?? 2,
      minScore: optInt(obj, "minScore", 0, MAX_SCORE),
      since: optDate(obj, "since"),
      limit: parseLimit(obj),
    };
  },
  async run(args, ctx) {
    const clock = await tenantClock(ctx);
    const tp = ctx.tenantPrisma;
    const { from } = checkRange(args.since ?? addDays(clock.today, -DEFAULT_SKIP_LOOKBACK_DAYS), clock.today);

    const [skip, complaints, debts, failed, unreachable] = await Promise.all([
      skipStreaks(tp, from, clock.today),
      tp.complaint.groupBy({ by: ["customerId"], where: { status: { not: ComplaintStatus.RESOLVED } }, _count: { _all: true } }),
      tp.invoice.groupBy({ by: ["customerId"], where: { status: InvoiceStatus.SENT }, _sum: { amount: true }, _min: { dueDate: true } }),
      tp.payment.groupBy({
        by: ["customerId"],
        where: { status: PaymentStatus.FAILED, method: PaymentMethod.GOCARDLESS, createdAt: { gte: instantRange(clock.tz, addDays(clock.today, -FAILED_DD_WINDOW_DAYS), clock.today).gte } },
        _count: { _all: true },
      }),
      tp.customer.findMany({ where: { OR: [{ messagesOptOut: true }, { emailInvalidAt: { not: null } }] }, select: { id: true, messagesOptOut: true, emailInvalidAt: true } }),
    ]);

    // Customers with a skip streak: the property with the longest streak (latest on a tie) represents the customer.
    const custs = new Map<string, Cust>();
    for (const s of skip.streaks) {
      const cur = custs.get(s.customerId);
      if (!cur || s.skips > cur.skips || (s.skips === cur.skips && s.skips > 0 && (cur.lastSkipped as string) < s.lastSkipped)) {
        custs.set(s.customerId, { customer: s.customer, address: s.address, skips: s.skips, lastSkipped: s.skips > 0 ? s.lastSkipped : null, reason: s.skips > 0 ? s.reason : null });
      }
    }

    const openComplaints = new Map(complaints.map((g) => [g.customerId, countOf(g._count)]));
    const debt = new Map(
      debts.map((g) => [g.customerId, { balance: num(g._sum.amount), daysOverdue: g._min.dueDate ? Math.max(0, daysBetween(dateToDay(g._min.dueDate), clock.today)) : 0 }])
    );
    const failedDd = new Map(failed.map((g) => [g.customerId, countOf(g._count)]));
    const contact = new Map(unreachable.map((c) => [c.id, { optOut: c.messagesOptOut === true, emailInvalid: c.emailInvalidAt != null }]));

    // minScore mode: customers with any signal but no skip streak still need a name and address.
    if (args.minScore !== undefined) {
      const missing = [...new Set([...openComplaints.keys(), ...debt.keys(), ...failedDd.keys(), ...contact.keys()])].filter((id) => !custs.has(id)).slice(0, MAX_LOOKUPS);
      if (missing.length > 0) {
        const found = await tp.customer.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, properties: { select: { addressLine: true }, take: 1 } } });
        for (const c of found) custs.set(c.id, { customer: c.name, address: c.properties[0]?.addressLine ?? "", skips: 0, lastSkipped: null, reason: null });
      }
    }

    const scored: ResultRow[] = [];
    for (const [id, c] of custs) {
      const complaintsOpen = openComplaints.get(id) ?? 0;
      const d = debt.get(id) ?? { balance: 0, daysOverdue: 0 };
      const dd = failedDd.get(id) ?? 0;
      const reach = contact.get(id) ?? { optOut: false, emailInvalid: false };

      const signals: string[] = [];
      let score = 0;
      if (c.skips > 0) {
        score += Math.min(SKIP_POINTS_MAX, c.skips * SKIP_POINTS_EACH);
        signals.push(`${c.skips} ${c.skips === 1 ? "skip" : "skips"} in a row`);
      }
      if (complaintsOpen > 0) {
        score += Math.min(COMPLAINT_POINTS_MAX, complaintsOpen * COMPLAINT_POINTS_EACH);
        signals.push(plural(complaintsOpen, "open complaint"));
      }
      const tier = d.balance > 0 && d.daysOverdue > 0 ? DEBT_POINT_TIERS.find((t) => d.daysOverdue > t.overDays) : undefined;
      if (tier) {
        score += tier.points;
        signals.push(`£${d.balance.toFixed(2)} owed, ${plural(d.daysOverdue, "day")} overdue`);
      }
      if (dd > 0) {
        score += FAILED_DD_POINTS;
        signals.push("failed direct debit");
      }
      if (reach.optOut) {
        score += OPT_OUT_POINTS;
        signals.push("messages opted out");
      }
      if (reach.emailInvalid) {
        score += EMAIL_INVALID_POINTS;
        signals.push("email address invalid");
      }
      score = Math.min(MAX_SCORE, score);

      if (args.minScore === undefined ? c.skips < args.minConsecutiveSkips : score < args.minScore) continue;
      scored.push({
        customer: c.customer,
        address: c.address,
        skips: c.skips,
        lastSkipped: c.lastSkipped,
        reason: c.reason,
        riskScore: score,
        signals: signals.length > 0 ? signals.join("; ") : "No risk signals",
        openComplaints: complaintsOpen,
        balanceOwed: round2(d.balance),
        daysOverdue: d.daysOverdue,
        failedDirectDebits: dd,
      });
    }
    const all = scored.sort(
      (a, b) =>
        (b.riskScore as number) - (a.riskScore as number) ||
        (b.skips as number) - (a.skips as number) ||
        ((b.lastSkipped as string | null) ?? "").localeCompare((a.lastSkipped as string | null) ?? "") ||
        (a.customer as string).localeCompare(b.customer as string)
    );
    const rows = all.slice(0, args.limit);
    return {
      dateRange: toDateRange(from, clock.today),
      rows,
      totals: all.length === 0 ? null : { customer: "Total", customers: all.length },
      truncated: skip.truncated || all.length > rows.length,
      columns: COLUMNS,
    };
  },
};
