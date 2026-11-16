import { LifecycleStatus, MessageDirection } from "../../../generated/tenant-client";
import type { MessageChannel, MessageDeliveryStatus } from "../../../generated/tenant-client";
import type { ResultRow, ToolDefinition, ToolName } from "../types";
import { columns, instantRange, localDayOf, optDate, optEnum, parseArgs, parseLimit, resolveRange, tenantClock, toDateRange } from "./shared";

// list_messages_delivery(from?, to?, channel?, status?, limit?): how outbound messages fared and who cannot be reached.
// The message BODY (and the provider error text and ids) are never selected: only channel, status, date, credits and
// the customer's name.

const CHANNELS = ["SMS", "WHATSAPP", "EMAIL"] as const satisfies readonly MessageChannel[];
const STATUSES = ["SENT", "DELIVERED", "BOUNCED", "COMPLAINED", "FAILED"] as const satisfies readonly MessageDeliveryStatus[];
const PROBLEM_STATUSES: readonly MessageDeliveryStatus[] = ["FAILED", "BOUNCED", "COMPLAINED"];

interface Args {
  from?: string;
  to?: string;
  channel?: (typeof CHANNELS)[number];
  status?: (typeof STATUSES)[number];
  limit: number;
}

const COLUMNS = columns(
  ["kind", "Row type", "text"],
  ["channel", "Channel", "text"],
  ["status", "Status", "text"],
  ["customer", "Customer", "text"],
  ["date", "Date", "date"],
  ["count", "Messages", "integer"],
  ["credits", "SMS credits", "integer"]
);

const blank = { channel: null, status: null, customer: null, date: null, count: null, credits: null };

export const listMessagesDelivery: ToolDefinition<Args> = {
  name: "list_messages_delivery",
  label: "Message delivery",
  readOnly: true,
  description:
    "How customer messages are being delivered over a date range (YYYY-MM-DD inclusive, max 366 days; default this month so far): outbound counts per channel (SMS, WHATSAPP, EMAIL) and delivery status, the individual failed, bounced or complained messages (channel, status, date, customer name and credits only, never the message text), inbound replies per channel, customers who cannot be contacted (opted out of messages or with an invalid email, name only) and SMS credits used. Optional filters: channel, status. Use for 'which reminders failed', 'who bounced', 'who has replied', 'who can't I message', 'how many SMS credits did we use'. Do not use to read or send messages. Example: {\"channel\":\"EMAIL\",\"status\":\"BOUNCED\"}. Glossary: row type 'Delivery summary' = outbound messages per channel and status; 'Failed message' = one problem message (or one of the chosen status); 'Inbound replies' = messages customers sent us; 'Cannot be contacted' = a customer we should not message. Totals: count = messages that failed, bounced or complained (or are of the chosen status); credits = SMS credits spent on all outbound messages in the range; customers = how many active customers cannot be contacted.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD, default first day of this month" },
      to: { type: "string", description: "YYYY-MM-DD, default today" },
      channel: { type: "string", enum: [...CHANNELS] },
      status: { type: "string", enum: [...STATUSES], description: "Only this delivery status; default shows failed, bounced and complained messages" },
      limit: { type: "integer", description: "Max detail rows (failed messages plus customers), 1 to 200, default 50" },
    },
    additionalProperties: false,
  },
  parse(raw) {
    const obj = parseArgs(raw, ["from", "to", "channel", "status", "limit"]);
    return { from: optDate(obj, "from"), to: optDate(obj, "to"), channel: optEnum(obj, "channel", CHANNELS), status: optEnum(obj, "status", STATUSES), limit: parseLimit(obj) };
  },
  async run(args, ctx) {
    const tp = ctx.tenantPrisma;
    const clock = await tenantClock(ctx);
    const { from, to } = resolveRange(args, clock);
    const createdAt = instantRange(clock.tz, from, to);
    const channel = args.channel ? { channel: args.channel } : {};
    const wanted: readonly MessageDeliveryStatus[] = args.status ? [args.status] : PROBLEM_STATUSES;

    const [outbound, inbound, failed, contactTotal] = await Promise.all([
      tp.message.groupBy({ by: ["channel", "deliveryStatus"], where: { direction: MessageDirection.OUTBOUND, createdAt, ...channel }, _count: true, _sum: { creditCost: true } }),
      tp.message.groupBy({ by: ["channel"], where: { direction: MessageDirection.INBOUND, createdAt, ...channel }, _count: true }),
      tp.message.findMany({
        where: { direction: MessageDirection.OUTBOUND, createdAt, deliveryStatus: { in: [...wanted] }, ...channel },
        select: { channel: true, deliveryStatus: true, createdAt: true, creditCost: true, customer: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: args.limit + 1,
      }),
      tp.customer.count({ where: { status: LifecycleStatus.ACTIVE, OR: [{ messagesOptOut: true }, { emailInvalidAt: { not: null } }] } }),
    ]);

    const failedShown = failed.slice(0, args.limit);
    const contactRoom = args.limit - failedShown.length;
    const contacts =
      contactRoom > 0
        ? await tp.customer.findMany({
            where: { status: LifecycleStatus.ACTIVE, OR: [{ messagesOptOut: true }, { emailInvalidAt: { not: null } }] },
            select: { name: true, messagesOptOut: true, emailInvalidAt: true },
            orderBy: { name: "asc" },
            take: contactRoom,
          })
        : [];

    const rows: ResultRow[] = [];
    let problemCount = 0;
    let credits = 0;
    for (const g of outbound) {
      const n = g._count;
      credits += g._sum.creditCost ?? 0;
      if (g.deliveryStatus !== null && wanted.includes(g.deliveryStatus)) problemCount += n;
      if (args.status && g.deliveryStatus !== args.status) continue;
      rows.push({ kind: "Delivery summary", ...blank, channel: g.channel, status: g.deliveryStatus, count: n, credits: g._sum.creditCost ?? 0 });
    }
    for (const g of inbound) rows.push({ kind: "Inbound replies", ...blank, channel: g.channel, count: g._count });
    for (const m of failedShown) {
      rows.push({ kind: "Failed message", ...blank, channel: m.channel, status: m.deliveryStatus, customer: m.customer?.name ?? null, date: localDayOf(m.createdAt, clock.tz), credits: m.creditCost });
    }
    for (const c of contacts) {
      rows.push({
        kind: "Cannot be contacted",
        ...blank,
        status: c.messagesOptOut && c.emailInvalidAt ? "Opted out and invalid email" : c.messagesOptOut ? "Opted out of messages" : "Invalid email",
        customer: c.name,
      });
    }
    return {
      dateRange: toDateRange(from, to),
      rows,
      totals: rows.length === 0 ? null : { kind: "Total", channel: null, status: null, customer: null, date: null, count: problemCount, credits, customers: contactTotal },
      truncated: failed.length > failedShown.length || contactTotal > contacts.length,
      columns: COLUMNS,
    };
  },
};
