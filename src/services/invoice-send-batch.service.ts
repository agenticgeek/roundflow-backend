import { randomUUID } from "node:crypto";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { InvoiceStatus, MessageChannel, Prisma } from "../generated/tenant-client";
import { invoiceWhere, createInvoiceService, type InvoiceListFilters, type InvoiceStatusFilter } from "./invoice.service";
import { bestChannel, createMessageService, pickChannel, type ChannelCaps } from "./message.service";
import { ChannelUnavailableError } from "./email.service";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "../lib/outbox-backoff";
import { notifyIntegrationDead } from "./notify";

// ACT-01: "Send all" for invoices. Sends are queued on the IntegrationOutbox
// (event `invoice.send`), never run inside the request. The channel decision is
// isolated in resolveInvoiceChannel(): EMAIL by default (native mailer, no GHL needed) when the customer has an
// email, SMS through GHL when connected and email is not possible.

export const INVOICE_SEND_EVENT = "invoice.send";
export const MAX_BATCH = 500;
/** A claimed row is invisible to other workers for this long (crash recovery). */
export const CLAIM_LEASE_MS = 10 * 60_000;
export const MAX_SEND_ATTEMPTS = OUTBOX_MAX_ATTEMPTS;
const HOUR_MS = 3_600_000;

export type BulkSkipReason =
  | "NOT_FOUND"
  | "NOT_DRAFT"
  | "PAID"
  | "VOID"
  | "NO_CONTACT_FOR_CHANNEL"
  | "CUSTOMER_OPTED_OUT"
  | "NO_AVAILABLE_CHANNEL"
  | "ALREADY_QUEUED";

const SKIP_TEXT: Record<BulkSkipReason, string> = {
  NOT_FOUND: "Invoice not found",
  NOT_DRAFT: "Invoice has already been sent (use resend)",
  PAID: "Invoice is already paid",
  VOID: "Invoice is void",
  NO_CONTACT_FOR_CHANNEL: "Customer has no contact detail for the channel",
  CUSTOMER_OPTED_OUT: "Customer has opted out of messages",
  NO_AVAILABLE_CHANNEL: "No email or SMS channel is available for this customer",
  ALREADY_QUEUED: "Already queued",
};

export type BatchItemStatus = "QUEUED" | "SENT" | "FAILED" | "SKIPPED";

export interface BulkSendSelection {
  ids?: string[];
  /** Used when `ids` is omitted. Default DRAFT. */
  status?: InvoiceStatusFilter;
  /** Narrow a status selection to the current view (customer, search, dates). */
  filters?: Omit<InvoiceListFilters, "status">;
  channel?: MessageChannel;
  resend?: boolean;
}

interface Candidate {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  status: InvoiceStatus;
  /** null = would be skipped (see skip). */
  channel: MessageChannel | null;
  skip: BulkSkipReason | null;
}

/** The channel decision for one invoice: opt-out first (all channels), then explicit choice, else EMAIL-first. */
export function resolveInvoiceChannel(
  customer: { phone: string | null; email: string | null; messagesOptOut: boolean; emailInvalidAt?: Date | null },
  requested: MessageChannel | undefined,
  caps: ChannelCaps
): { channel: MessageChannel } | { skip: "CUSTOMER_OPTED_OUT" | "NO_CONTACT_FOR_CHANNEL" | "NO_AVAILABLE_CHANNEL" } {
  if (customer.messagesOptOut) return { skip: "CUSTOMER_OPTED_OUT" };
  if (requested) {
    try {
      return { channel: pickChannel({ id: "", name: "", ghlContactId: null, ...customer }, requested, caps) };
    } catch (err) {
      return { skip: err instanceof ChannelUnavailableError ? "NO_AVAILABLE_CHANNEL" : "NO_CONTACT_FOR_CHANNEL" };
    }
  }
  if (!customer.phone && !customer.email) return { skip: "NO_CONTACT_FOR_CHANNEL" };
  const best = bestChannel({ id: "", name: "", ghlContactId: null, ...customer }, MessageChannel.EMAIL, caps);
  return "skip" in best ? { skip: "NO_AVAILABLE_CHANNEL" } : best;
}

function skipForStatus(status: InvoiceStatus, resend: boolean): BulkSkipReason | null {
  if (status === InvoiceStatus.PAID) return "PAID";
  if (status === InvoiceStatus.VOID) return "VOID";
  if (status === InvoiceStatus.SENT && !resend) return "NOT_DRAFT";
  return null;
}

/** Idempotency key: one send per invoice; a deliberate resend gets an hourly bucket so a double click still sends once. */
export function dedupeKeyFor(invoiceId: string, status: InvoiceStatus, now: Date = new Date()): string {
  return status === InvoiceStatus.SENT
    ? `${INVOICE_SEND_EVENT}:${invoiceId}:resend:${Math.floor(now.getTime() / HOUR_MS)}`
    : `${INVOICE_SEND_EVENT}:${invoiceId}`;
}

// Parses "CODE: message" as stored in IntegrationOutbox.lastError.
function splitError(lastError: string | null): { error?: string; code?: string } {
  if (!lastError) return {};
  const m = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(lastError);
  return m ? { code: m[1], error: m[2] } : { error: lastError };
}

const statusOfRow = (status: string): BatchItemStatus =>
  status === "pending" ? "QUEUED" : status === "sent" ? "SENT" : status === "failed" || status === "dead" ? "FAILED" : "SKIPPED";

export function createInvoiceSendBatchService(prisma: TenantPrismaClient) {
  const load = async (sel: BulkSendSelection): Promise<{ candidates: Candidate[]; missing: string[]; truncated: boolean; totalMatching: number }> => {
    const resend = sel.resend === true;
    let missing: string[] = [];
    let truncated = false;
    let totalMatching: number;
    const include = { customer: { select: { id: true, name: true, phone: true, email: true, emailInvalidAt: true, messagesOptOut: true } } } as const;

    let invoices;
    if (sel.ids) {
      if (sel.ids.length === 0 || sel.ids.length > MAX_BATCH) {
        throw new AppError(400, `"ids" must contain 1 to ${MAX_BATCH} invoice ids`, "INVALID_BATCH_SIZE");
      }
      const unique = [...new Set(sel.ids)];
      invoices = await prisma.invoice.findMany({ where: { id: { in: unique } }, include, orderBy: { createdAt: "asc" } });
      const found = new Set(invoices.map((i) => i.id));
      missing = unique.filter((id) => !found.has(id));
      totalMatching = invoices.length;
    } else {
      const where = invoiceWhere({ ...sel.filters, status: sel.status ?? InvoiceStatus.DRAFT });
      totalMatching = await prisma.invoice.count({ where });
      truncated = totalMatching > MAX_BATCH;
      invoices = await prisma.invoice.findMany({ where, include, orderBy: { createdAt: "asc" }, take: MAX_BATCH });
    }

    const caps = invoices.length > 0 ? await createMessageService(prisma).channelCaps() : null;
    const candidates = invoices.map((inv): Candidate => {
      const base = { id: inv.id, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, customerName: inv.customer.name, status: inv.status };
      const byStatus = skipForStatus(inv.status, resend);
      if (byStatus) return { ...base, channel: null, skip: byStatus };
      const decision = resolveInvoiceChannel(inv.customer, sel.channel, caps as ChannelCaps);
      return "skip" in decision ? { ...base, channel: null, skip: decision.skip } : { ...base, channel: decision.channel, skip: null };
    });
    return { candidates, missing, truncated, totalMatching };
  };

  return {
    // POST /invoices/bulk-send/preview: counts per channel and per skip reason; nothing is queued.
    preview: async (sel: BulkSendSelection) => {
      const { candidates, missing, truncated, totalMatching } = await load(sel);
      const byChannel: Record<string, number> = {};
      const skipped: Record<string, number> = {};
      for (const c of candidates) {
        if (c.channel) byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1;
        else skipped[c.skip!] = (skipped[c.skip!] ?? 0) + 1;
      }
      if (missing.length) skipped.NOT_FOUND = missing.length;
      return {
        total: candidates.length + missing.length,
        willSend: candidates.filter((c) => c.channel).length,
        byChannel,
        skipped,
        truncated,
        totalMatching,
        invoices: candidates.map((c) => ({
          id: c.id,
          invoiceNumber: c.invoiceNumber,
          customerName: c.customerName,
          channel: c.channel,
          skip: c.skip,
        })),
      };
    },

    // POST /invoices/bulk-send: queue one `invoice.send` outbox row per sendable invoice.
    send: async (sel: BulkSendSelection) => {
      const { candidates, missing, truncated } = await load(sel);
      const batchId = randomUUID();
      const skipped: { id: string; reason: BulkSkipReason }[] = missing.map((id) => ({ id, reason: "NOT_FOUND" }));
      let queued = 0;
      const now = new Date();

      for (const c of candidates) {
        if (!c.channel) {
          skipped.push({ id: c.id, reason: c.skip! });
          continue;
        }
        const dedupeKey = dedupeKeyFor(c.id, c.status, now);
        const payload = {
          customerId: c.customerId,
          invoiceId: c.id,
          channel: c.channel,
          resend: c.status === InvoiceStatus.SENT,
          batchId,
        };
        try {
          await prisma.integrationOutbox.create({ data: { eventType: INVOICE_SEND_EVENT, payload, dedupeKey, batchId } });
          queued += 1;
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
          // Same key already exists: a finished attempt is re-armed for this batch, an in-flight one is a double click.
          const rearmed = await prisma.integrationOutbox.updateMany({
            where: { dedupeKey, status: { in: ["sent", "failed", "dead", "skipped", "cancelled"] } },
            data: { status: "pending", attempts: 0, lastError: null, processedAt: null, runAfter: null, payload, batchId },
          });
          if (rearmed.count === 1) queued += 1;
          else skipped.push({ id: c.id, reason: "ALREADY_QUEUED" });
        }
      }
      // BUG-001: record what was skipped under the batch too, so GET /invoices/bulk-send/{batchId} works (and shows the
      // reasons) even when nothing at all was queued. These rows are born finished (status skipped), the worker ignores them.
      const recorded = skipped.filter((s) => s.reason !== "ALREADY_QUEUED");
      if (recorded.length > 0) {
        const customerOf = new Map(candidates.map((c) => [c.id, c.customerId]));
        const processedAt = new Date();
        await prisma.integrationOutbox.createMany({
          data: recorded.map((s) => ({
            eventType: INVOICE_SEND_EVENT,
            batchId,
            status: "skipped",
            processedAt,
            lastError: `${s.reason}: ${SKIP_TEXT[s.reason]}`,
            payload: { invoiceId: s.id, ...(customerOf.has(s.id) ? { customerId: customerOf.get(s.id) } : {}), batchId },
          })),
        });
      }
      return { batchId, queued, skipped, ...(truncated ? { truncated: true } : {}) };
    },

    // GET /invoices/bulk-send/:batchId
    getBatch: async (batchId: string) => {
      const rows = await prisma.integrationOutbox.findMany({
        where: { batchId, eventType: INVOICE_SEND_EVENT },
        orderBy: { createdAt: "asc" },
      });
      if (rows.length === 0) throw new AppError(404, "Batch not found", "BATCH_NOT_FOUND");
      const results = rows.map((r) => {
        const status = statusOfRow(r.status);
        return {
          id: (r.payload as { invoiceId: string }).invoiceId,
          status,
          ...(status === "QUEUED" ? {} : splitError(r.lastError)),
        };
      });
      const counts = { QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };
      for (const r of results) counts[r.status] += 1;
      return { batchId, total: results.length, done: counts.QUEUED === 0, counts, results };
    },
  };
}

// ---- worker side ------------------------------------------------------------

type OutboxRow = { id: string; attempts: number; payload: unknown };
type SendPayload = { customerId?: string; invoiceId?: string; channel?: MessageChannel; resend?: boolean };

// Codes that will never succeed on retry.
const TERMINAL_CODES = new Set(["NO_CONTACT_FOR_CHANNEL", "INVOICE_NOT_SENDABLE", "INVOICE_ALREADY_SENT"]);

/**
 * Drains one `invoice.send` row. Atomic claim first (a lease on runAfter, so a
 * second worker or a duplicate row can never send the same row twice and a
 * crashed worker's row comes back after CLAIM_LEASE_MS). The invoice flips to
 * SENT only inside sendInvoice(), after the provider accepted the message.
 */
export async function processInvoiceSendRow(tp: TenantPrismaClient, row: OutboxRow): Promise<void> {
  const now = new Date();
  const claim = await tp.integrationOutbox.updateMany({
    where: { id: row.id, status: "pending", OR: [{ runAfter: null }, { runAfter: { lte: now } }] },
    data: { runAfter: new Date(now.getTime() + CLAIM_LEASE_MS) },
  });
  if (claim.count !== 1) return;

  const finish = (status: string, lastError: string | null = null) =>
    tp.integrationOutbox.update({
      where: { id: row.id },
      data: { status, lastError, processedAt: new Date(), runAfter: null },
    });
  const skip = (code: string, message: string) => finish("skipped", `${code}: ${message}`);

  const payload = row.payload as SendPayload;
  try {
    if (!payload.invoiceId || !payload.customerId) throw new AppError(400, "payload missing invoiceId/customerId", "INVALID_PAYLOAD");

    const customer = await tp.customer.findUnique({ where: { id: payload.customerId }, select: { messagesOptOut: true } });
    if (!customer || customer.messagesOptOut) return void (await skip("CUSTOMER_OPTED_OUT", "Customer has opted out of messages"));

    const invoice = await tp.invoice.findUnique({ where: { id: payload.invoiceId }, select: { status: true } });
    if (!invoice || invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.VOID) {
      return void (await skip("INVOICE_NOT_SENDABLE", "Invoice is paid, void or missing"));
    }
    if (invoice.status === InvoiceStatus.SENT && !payload.resend) {
      return void (await skip("INVOICE_ALREADY_SENT", "Invoice has already been sent"));
    }

    await createInvoiceService(tp).sendInvoice(payload.invoiceId, { channel: payload.channel, resend: payload.resend === true });
    await finish("sent");
  } catch (err) {
    const code = err instanceof AppError ? err.code : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const lastError = code ? `${code}: ${message}` : message;
    const attempts = row.attempts + 1;

    if (code && TERMINAL_CODES.has(code)) {
      await finish("failed", lastError);
      return;
    }
    const dead = attempts >= MAX_SEND_ATTEMPTS;
    await tp.integrationOutbox.update({
      where: { id: row.id },
      data: {
        attempts,
        lastError,
        status: dead ? "dead" : "pending",
        // exponential back-off before the next try (also releases the claim lease)
        runAfter: dead ? null : new Date(Date.now() + outboxBackoffMs(attempts)),
        ...(dead ? { processedAt: new Date() } : {}),
      },
    });
    if (dead) {
      console.error(`[outbox] invoice.send row ${row.id} dead after ${MAX_SEND_ATTEMPTS} attempts:`, err);
      await notifyIntegrationDead(tp, { id: row.id, eventType: INVOICE_SEND_EVENT, lastError });
    }
  }
}
