import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { InvoiceStatus, LifecycleStatus, MessageChannel, MessageDirection, VisitStatus } from "../generated/tenant-client";
import { getGhlToken, createGhlContact, sendGhlMessage, GhlTokenContext } from "../integrations/ghl/api";
import { formatMoney, formatTemplateDate, renderTemplate, type TemplateVars } from "./message-templates";
import { tenantToday } from "./business-time";

const CHANNELS = new Set<string>(Object.values(MessageChannel));

type ContactCustomer = { id: string; name: string; phone: string | null; email: string | null; ghlContactId: string | null };

// A customer + channel + GHL token, resolved and checked *before* anything
// with side effects (e.g. creating a Stripe session for a payment link) runs.
export interface PreparedSend {
  customer: ContactCustomer;
  channel: MessageChannel;
  ctx: GhlTokenContext;
}

function normaliseChannel(channel: string): MessageChannel {
  const upper = channel.toUpperCase();
  if (!CHANNELS.has(upper)) {
    throw new AppError(400, `channel must be one of: ${[...CHANNELS].join(", ")}`);
  }
  return upper as MessageChannel;
}

/** Optional channel from a request body: undefined/null/"AUTO" = pick the
 *  default for the customer; otherwise SMS | EMAIL | WHATSAPP (any case). */
export function optOutboundChannel(v: unknown): MessageChannel | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new AppError(400, "channel must be a string");
  if (v.toUpperCase() === "AUTO") return undefined;
  return normaliseChannel(v);
}

/** Default: SMS when the customer has a mobile, otherwise EMAIL. The chosen
 *  channel must have a matching contact detail (email only for EMAIL). */
export function resolveChannel(
  customer: { phone: string | null; email: string | null },
  requested?: MessageChannel
): MessageChannel {
  const channel = requested ?? (customer.phone ? MessageChannel.SMS : MessageChannel.EMAIL);
  if (channel === MessageChannel.EMAIL ? !customer.email : !customer.phone) {
    throw new AppError(
      400,
      channel === MessageChannel.EMAIL
        ? "Customer has no email address on file"
        : "Customer has no mobile number on file",
      "NO_CONTACT_FOR_CHANNEL"
    );
  }
  return channel;
}

const customerSelect = { id: true, name: true, phone: true, email: true, ghlContactId: true } as const;

export type BroadcastRecipientStatus = "sent" | "scheduled" | "skipped_opted_out" | "skipped_no_contact" | "failed";

export interface BroadcastRecipient {
  customerId: string;
  customerName: string;
  status: BroadcastRecipientStatus;
  channel?: MessageChannel;
  /** Why it was skipped / failed. */
  error?: string;
}

export interface BroadcastResult {
  /** sent + scheduled (kept for older clients that only read `queued`). */
  queued: number;
  sent: number;
  scheduled: number;
  skippedOptedOut: number;
  skippedNoContact: number;
  failed: number;
  /** ISO time the messages were queued for; null = sent immediately. */
  scheduledFor: string | null;
  recipients: BroadcastRecipient[];
}

/** One customer to message, with the {{variables}} their copy is rendered with. */
export interface BroadcastTarget {
  customer: ContactCustomer & { messagesOptOut: boolean };
  vars: TemplateVars;
}

const AMOUNT_TOKEN_RE = /\{\{\s*amount\s*\}\}|\[\s*amount\s*\]/i;

export function createMessageService(prisma: TenantPrismaClient) {
  // Resolve (creating + persisting if missing) the GHL contact id for a customer.
  const ensureContact = async (ctx: GhlTokenContext, c: ContactCustomer): Promise<string> => {
    if (c.ghlContactId) return c.ghlContactId;
    const contactId = await createGhlContact(ctx, c);
    await prisma.customer.update({ where: { id: c.id }, data: { ghlContactId: contactId } });
    return contactId;
  };

  const requireGhl = async (): Promise<GhlTokenContext> => {
    const ctx = await getGhlToken(prisma);
    if (!ctx) throw new AppError(409, "GoHighLevel is not connected", "GHL_NOT_CONNECTED");
    return ctx;
  };

  const prepare = async (customerId: string, channel?: string): Promise<PreparedSend> => {
    const requested = channel === undefined ? undefined : normaliseChannel(channel);
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: customerSelect });
    if (!customer) throw new AppError(404, "Customer not found");
    const resolved = resolveChannel(customer, requested);
    const ctx = await requireGhl();
    return { customer, channel: resolved, ctx };
  };

  // Send through GHL, then record the outbound Message — only once GHL has
  // accepted it, so the history never shows a message that wasn't delivered.
  const deliver = async (prep: PreparedSend, body: string, opts?: { templateId?: string | null }) => {
    let externalId: string | null;
    try {
      const contactId = await ensureContact(prep.ctx, prep.customer);
      externalId = await sendGhlMessage(prep.ctx, contactId, body, prep.channel);
    } catch (err) {
      console.error(`[messages] GHL send to customer ${prep.customer.id} failed:`, err);
      throw new AppError(502, `GoHighLevel could not send the message: ${(err as Error).message}`, "GHL_SEND_FAILED");
    }
    const msg = await prisma.message.create({
      data: {
        channel: prep.channel,
        direction: MessageDirection.OUTBOUND,
        body,
        customerId: prep.customer.id,
        templateId: opts?.templateId ?? null,
        externalId,
        sentAt: new Date(),
      },
    });
    return { messageId: msg.id, channel: prep.channel };
  };

  // Distinct customers of a round (first property supplies {{address}} etc.) with their
  // per-customer template vars, minus payment-hold customers when asked.
  const buildRoundTargets = async (roundId: string, excludePaymentHold: boolean) => {
    const [props, round, settings, today] = await Promise.all([
      prisma.property.findMany({
        where: { roundId, status: { not: LifecycleStatus.CANCELLED } },
        select: {
          id: true,
          addressLine: true,
          customer: { select: { ...customerSelect, messagesOptOut: true } },
          visits: { where: { paymentHold: true }, select: { id: true }, take: 1 },
        },
      }),
      prisma.round.findUnique({ where: { id: roundId }, select: { name: true } }),
      prisma.businessSettings.findFirst({ select: { businessName: true, currency: true } }),
      tenantToday(prisma),
    ]);
    if (!round) throw new AppError(404, "Round not found");

    // Each property's next scheduled visit (date + technician) for {{date}} / {{technicianName}}.
    const upcoming = await prisma.visit.findMany({
      where: { roundId, status: VisitStatus.SCHEDULED, date: { gte: today } },
      orderBy: { date: "asc" },
      select: { propertyId: true, date: true, technician: { select: { name: true } } },
    });
    const nextVisit = new Map<string, (typeof upcoming)[number]>();
    for (const v of upcoming) if (!nextVisit.has(v.propertyId)) nextVisit.set(v.propertyId, v);

    const byCustomer = new Map<string, BroadcastTarget>();
    for (const p of props) {
      if (excludePaymentHold && p.visits.length) continue;
      if (byCustomer.has(p.customer.id)) continue;
      const visit = nextVisit.get(p.id);
      byCustomer.set(p.customer.id, {
        customer: p.customer,
        vars: {
          customerName: p.customer.name,
          firstName: p.customer.name.split(" ")[0],
          address: p.addressLine,
          date: visit ? formatTemplateDate(visit.date) : "",
          technicianName: visit?.technician?.name ?? "",
          roundName: round.name,
          businessName: settings?.businessName ?? "",
        },
      });
    }
    return { targets: [...byCustomer.values()], settings };
  };

  // Render the body per customer, honour messagesOptOut, then send now (each
  // success persisted as a Message row via deliver) or queue on the outbox for
  // `scheduledFor`. Best-effort per recipient: one customer's problem never
  // throws, it is reported in `recipients`. GHL must be connected (409) or
  // nothing is attempted.
  const broadcast = async (
    targets: BroadcastTarget[],
    opts: {
      body: string;
      channel?: MessageChannel;
      templateId?: string | null;
      scheduledFor?: Date;
      reason: string;
      extraPayload?: Record<string, unknown>;
    }
  ): Promise<BroadcastResult> => {
    const ctx = await requireGhl();
    const recipients: BroadcastRecipient[] = [];

    for (const { customer, vars } of targets) {
      const base = { customerId: customer.id, customerName: customer.name };
      if (customer.messagesOptOut) {
        recipients.push({ ...base, status: "skipped_opted_out" });
        continue;
      }

      let channel: MessageChannel;
      try {
        channel = resolveChannel(customer, opts.channel);
      } catch (err) {
        recipients.push({ ...base, status: "skipped_no_contact", error: (err as Error).message });
        continue;
      }

      const body = renderTemplate(opts.body, vars);
      try {
        if (opts.scheduledFor) {
          await prisma.integrationOutbox.create({
            data: {
              eventType: "message.send",
              runAfter: opts.scheduledFor,
              payload: { customerId: customer.id, channel, body, templateId: opts.templateId ?? null, reason: opts.reason, ...opts.extraPayload },
            },
          });
          recipients.push({ ...base, status: "scheduled", channel });
        } else {
          await deliver({ customer, channel, ctx }, body, { templateId: opts.templateId });
          recipients.push({ ...base, status: "sent", channel });
        }
      } catch (err) {
        console.error(`[messages] ${opts.reason} send to customer ${customer.id} failed:`, err);
        recipients.push({ ...base, status: "failed", channel, error: (err as Error).message });
      }
    }

    const count = (status: BroadcastRecipientStatus) => recipients.filter((r) => r.status === status).length;
    const sent = count("sent");
    const scheduled = count("scheduled");
    return {
      queued: sent + scheduled,
      sent,
      scheduled,
      skippedOptedOut: count("skipped_opted_out"),
      skippedNoContact: count("skipped_no_contact"),
      failed: count("failed"),
      scheduledFor: opts.scheduledFor ? opts.scheduledFor.toISOString() : null,
      recipients,
    };
  };

  return {
    prepare,
    deliver,
    broadcast,
    /** 409 GHL_NOT_CONNECTED — lets callers fail before they change anything. */
    assertGhlConnected: async (): Promise<void> => {
      await requireGhl();
    },

    // Send one message to a customer (resolved by property or customer id) via GHL.
    // channel omitted = SMS if the customer has a mobile, else EMAIL.
    send: async (input: { propertyId?: string; customerId?: string; channel?: string; body: string; templateId?: string | null }) => {
      if (input.channel !== undefined) normaliseChannel(input.channel);

      let customerId = input.customerId;
      if (!customerId && input.propertyId) {
        const p = await prisma.property.findUnique({
          where: { id: input.propertyId },
          select: { customerId: true },
        });
        if (!p) throw new AppError(404, "Property not found");
        customerId = p.customerId;
      }
      if (!customerId) throw new AppError(400, "propertyId or customerId is required");

      const prep = await prepare(customerId, input.channel);
      const sent = await deliver(prep, input.body, { templateId: input.templateId });
      return { status: "sent" as const, ...sent };
    },

    // Inbound replies stored by the GHL webhook (direction INBOUND), newest first.
    // `unread` = the office has not marked it read (Message.readAt null).
    listInbox: async (opts: { customerId?: string; unreadOnly?: boolean; page: number; pageSize: number }) => {
      const where = {
        direction: MessageDirection.INBOUND,
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
        ...(opts.unreadOnly ? { readAt: null } : {}),
      };
      const [total, unreadTotal, rows] = await Promise.all([
        prisma.message.count({ where }),
        prisma.message.count({ where: { ...where, readAt: null } }),
        prisma.message.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (opts.page - 1) * opts.pageSize,
          take: opts.pageSize,
          include: { customer: { select: { id: true, name: true } } },
        }),
      ]);
      return {
        rows: rows.map((m) => ({
          id: m.id,
          customerId: m.customerId,
          customerName: m.customer?.name ?? null,
          channel: m.channel,
          body: m.body,
          receivedAt: m.sentAt ?? m.createdAt,
          unread: m.readAt === null,
        })),
        unreadCount: unreadTotal,
        pagination: { page: opts.page, pageSize: opts.pageSize, total, totalPages: Math.ceil(total / opts.pageSize) },
      };
    },

    // Marks inbound messages read: the given ids, or every unread one of a customer.
    markInboxRead: async (input: { ids?: string[]; customerId?: string }) => {
      if (!input.ids?.length && !input.customerId) throw new AppError(400, "ids or customerId is required");
      const result = await prisma.message.updateMany({
        where: {
          direction: MessageDirection.INBOUND,
          readAt: null,
          ...(input.ids?.length ? { id: { in: input.ids } } : {}),
          ...(input.customerId ? { customerId: input.customerId } : {}),
        },
        data: { readAt: new Date() },
      });
      return { updated: result.count };
    },

    // Who a round broadcast would reach, for the composer's recipient list. Read-only (GHL
    // need not be connected). `status` is per customer for the given channel (default SMS):
    // ok | opted_out | no_contact.
    listRoundRecipients: async (input: { roundId: string; channel?: string; excludePaymentHold: boolean }) => {
      const channel = input.channel === undefined ? MessageChannel.SMS : normaliseChannel(input.channel);
      const { targets } = await buildRoundTargets(input.roundId, input.excludePaymentHold);
      const recipients = targets.map(({ customer, vars }) => {
        let status: "ok" | "opted_out" | "no_contact" = "ok";
        if (customer.messagesOptOut) status = "opted_out";
        else {
          try {
            resolveChannel(customer, channel);
          } catch {
            status = "no_contact";
          }
        }
        return { customerId: customer.id, customerName: customer.name, address: vars.address, status };
      });
      return { total: recipients.length, reachable: recipients.filter((r) => r.status === "ok").length, recipients };
    },

    // Broadcast one message to every customer in a round (or just `customerIds`, a subset of
    // them): right now, or queued for `scheduledFor`. {{variables}} are rendered per customer
    // (their own address, next visit, technician, balance owed...). excludePaymentHold drops
    // any customer whose round properties all have a payment-hold visit. Opted-out customers
    // are skipped; the result reports every recipient.
    sendToRound: async (input: {
      roundId: string;
      channel: string;
      body: string;
      excludePaymentHold: boolean;
      customerIds?: string[];
      templateId?: string | null;
      scheduledFor?: Date;
    }): Promise<BroadcastResult> => {
      const channel = normaliseChannel(input.channel);
      await requireGhl();

      const { targets: all, settings } = await buildRoundTargets(input.roundId, input.excludePaymentHold);
      let targets = all;
      if (input.customerIds) {
        const wanted = new Set(input.customerIds);
        const known = new Set(all.map((t) => t.customer.id));
        if ([...wanted].some((id) => !known.has(id))) {
          throw new AppError(400, "customerIds must all be recipients of this round", "UNKNOWN_RECIPIENT");
        }
        targets = all.filter((t) => wanted.has(t.customer.id));
      }

      // Balance owed is one aggregate per customer — only worth it when the copy uses {{amount}}.
      if (AMOUNT_TOKEN_RE.test(input.body)) {
        for (const { customer, vars } of targets) {
          const owed = await prisma.invoice.aggregate({
            where: { customerId: customer.id, status: InvoiceStatus.SENT },
            _sum: { amount: true },
          });
          vars.amount = formatMoney(Number(owed._sum.amount ?? 0), settings?.currency);
        }
      }

      return broadcast(targets, {
        body: input.body,
        channel,
        templateId: input.templateId,
        scheduledFor: input.scheduledFor,
        reason: "ROUND_MESSAGE",
        extraPayload: { roundId: input.roundId },
      });
    },
  };
}
