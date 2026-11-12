import { randomUUID } from "crypto";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { ChannelUnavailableError, getEmailAvailability, sendTenantEmail, unavailableError, type EmailAvailability } from "./email.service";
import type { EmailAttachment } from "../lib/mailer/ses";
import { InvoiceStatus, LifecycleStatus, MessageChannel, MessageDeliveryStatus, MessageDirection, VisitStatus } from "../generated/tenant-client";
import { getGhlToken, createGhlContact, sendGhlMessage, GhlTokenContext } from "../integrations/ghl/api";
import { formatMoney, formatTemplateDate, renderTemplate, type TemplateVars } from "./message-templates";
import { tenantToday } from "./business-time";

const CHANNELS = new Set<string>(Object.values(MessageChannel));

type ContactCustomer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  ghlContactId: string | null;
  /** Set by a hard bounce / complaint (SES): the address is not used until it is edited. */
  emailInvalidAt?: Date | null;
  messagesOptOut?: boolean;
};

// A customer + channel (+ GHL token for SMS/WhatsApp), resolved and checked *before* anything with side effects
// (e.g. creating a Stripe session for a payment link) runs. `ctx` is null for EMAIL (native mailer).
export interface PreparedSend {
  customer: ContactCustomer;
  channel: MessageChannel;
  ctx: GhlTokenContext | null;
}

/** What can be sent right now: GHL (SMS/WhatsApp) connected? Email available (SES configured, tenant on, not paused)? */
export interface ChannelCaps {
  ghl: boolean;
  email: EmailAvailability;
}

export type SkipReason = "NO_AVAILABLE_CHANNEL" | "CUSTOMER_OPTED_OUT";

const GHL_REQUIRED_MESSAGE = "SMS and WhatsApp need GoHighLevel to be connected (Settings > SMS and calling). Send by email instead.";
const EMAIL_INVALID_MESSAGE = "This customer's email address bounced or was reported as spam, so we no longer email it. Edit the address to try again.";

/** Router for ONE explicit or AUTO send. Throws a typed 400/409 when the message cannot go out. */
export function pickChannel(customer: ContactCustomer, requested: MessageChannel | undefined, caps: ChannelCaps, preferred?: MessageChannel): MessageChannel {
  if (requested) {
    const channel = resolveChannel(customer, requested); // 400 NO_CONTACT_FOR_CHANNEL
    if (channel === MessageChannel.EMAIL) {
      if (customer.emailInvalidAt) throw new ChannelUnavailableError("EMAIL_ADDRESS_INVALID", EMAIL_INVALID_MESSAGE, "EMAIL");
      if (!caps.email.available) throw unavailableError(caps.email);
    } else if (!caps.ghl) {
      throw new ChannelUnavailableError("GHL_NOT_CONNECTED", GHL_REQUIRED_MESSAGE, channel);
    }
    return channel;
  }
  const emailUsable = !!customer.email && !customer.emailInvalidAt && caps.email.available;
  if (preferred === MessageChannel.EMAIL && emailUsable) return MessageChannel.EMAIL;
  if (customer.phone && caps.ghl) return MessageChannel.SMS;
  if (emailUsable) return MessageChannel.EMAIL;
  if (!customer.phone && !customer.email) {
    throw new AppError(400, "Customer has no phone or email on file", "NO_CONTACT_FOR_CHANNEL");
  }
  if (customer.email) {
    if (customer.emailInvalidAt) throw new ChannelUnavailableError("EMAIL_ADDRESS_INVALID", EMAIL_INVALID_MESSAGE, "EMAIL");
    // Present, valid and not usable: the channel itself is unavailable.
    throw unavailableError(caps.email as Extract<EmailAvailability, { available: false }>);
  }
  throw new ChannelUnavailableError("GHL_NOT_CONNECTED", GHL_REQUIRED_MESSAGE, MessageChannel.SMS);
}

/** Router for automated flows: best usable channel for the customer, else a skip reason (never throws). */
export function bestChannel(
  customer: ContactCustomer & { messagesOptOut: boolean },
  preferred: MessageChannel | undefined,
  caps: ChannelCaps
): { channel: MessageChannel } | { skip: SkipReason } {
  if (customer.messagesOptOut) return { skip: "CUSTOMER_OPTED_OUT" };
  const emailUsable = !!customer.email && !customer.emailInvalidAt && caps.email.available;
  const phoneUsable = !!customer.phone && caps.ghl;
  const order = preferred
    ? [preferred, ...[MessageChannel.SMS, MessageChannel.EMAIL].filter((c) => c !== preferred)]
    : [MessageChannel.SMS, MessageChannel.EMAIL];
  const channel = order.find((c) => (c === MessageChannel.EMAIL ? emailUsable : phoneUsable));
  return channel ? { channel } : { skip: "NO_AVAILABLE_CHANNEL" };
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

const customerSelect = { id: true, name: true, phone: true, email: true, ghlContactId: true, emailInvalidAt: true, messagesOptOut: true } as const;

export type BroadcastRecipientStatus = "sent" | "scheduled" | "skipped_opted_out" | "skipped_no_contact" | "skipped_no_channel" | "failed";

export interface BroadcastRecipient {
  customerId: string;
  customerName: string;
  status: BroadcastRecipientStatus;
  channel?: MessageChannel;
  /** Why it was skipped / failed. */
  error?: string;
  /** Machine-readable skip reason (CUSTOMER_OPTED_OUT, NO_AVAILABLE_CHANNEL). */
  reason?: SkipReason;
}

export interface BroadcastResult {
  /** sent + scheduled (kept for older clients that only read `queued`). */
  queued: number;
  sent: number;
  scheduled: number;
  skippedOptedOut: number;
  skippedNoContact: number;
  /** No usable channel for the customer (e.g. only a mobile and GHL is not connected). */
  skippedNoChannel: number;
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

  const getCaps = async (): Promise<ChannelCaps & { ctx: GhlTokenContext | null }> => {
    const [ctx, email] = await Promise.all([getGhlToken(prisma), getEmailAvailability(prisma)]);
    return { ghl: !!ctx, email, ctx };
  };

  // Explicit channel chosen up front (round broadcasts): fail before anything is attempted when it cannot work.
  const assertChannelUsable = (channel: MessageChannel, caps: ChannelCaps): void => {
    if (channel === MessageChannel.EMAIL) {
      if (!caps.email.available) throw unavailableError(caps.email);
    } else if (!caps.ghl) {
      throw new ChannelUnavailableError("GHL_NOT_CONNECTED", GHL_REQUIRED_MESSAGE, channel);
    }
  };

  const assertAnyAvailable = (caps: ChannelCaps): void => {
    if (!caps.ghl && !caps.email.available) {
      throw new ChannelUnavailableError("NO_AVAILABLE_CHANNEL", "No messaging channel is available: email is unavailable and GoHighLevel (SMS) is not connected.");
    }
  };

  const prepare = async (customerId: string, channel?: string, opts?: { respectOptOut?: boolean; preferred?: MessageChannel | string }): Promise<PreparedSend> => {
    const requested = channel === undefined ? undefined : normaliseChannel(channel);
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: customerSelect });
    if (!customer) throw new AppError(404, "Customer not found");
    if (opts?.respectOptOut && customer.messagesOptOut) {
      throw new AppError(409, "Customer has opted out of messages", "CUSTOMER_OPTED_OUT");
    }
    const caps = await getCaps();
    const resolved = pickChannel(customer, requested, caps, opts?.preferred === undefined ? undefined : normaliseChannel(opts.preferred));
    return { customer, channel: resolved, ctx: resolved === MessageChannel.EMAIL ? null : caps.ctx };
  };

  // EMAIL goes through the native mailer, SMS/WhatsApp through GHL. The outbound Message is recorded only once the
  // provider has accepted it, so the history never shows a message that wasn't sent. EMAIL rows start as SENT and are
  // moved to DELIVERED / BOUNCED / COMPLAINED by the SES webhook.
  const deliver = async (
    prep: PreparedSend,
    body: string,
    opts?: {
      templateId?: string | null;
      complaintId?: string | null;
      subject?: string;
      transactional?: boolean;
      cta?: { label: string; url: string };
      summary?: Array<[string, string]>;
      attachments?: EmailAttachment[];
    }
  ) => {
    if (prep.channel === MessageChannel.EMAIL) {
      const id = randomUUID();
      const sentEmail = await sendTenantEmail(prisma, {
        to: prep.customer.email as string,
        subject: opts?.subject,
        bodyText: body,
        transactional: opts?.transactional ?? false,
        messageId: id,
        ...(opts?.cta ? { cta: opts.cta } : {}),
        ...(opts?.summary ? { summary: opts.summary } : {}),
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      });
      const now = new Date();
      const msg = await prisma.message.create({
        data: {
          id,
          channel: prep.channel,
          direction: MessageDirection.OUTBOUND,
          body,
          customerId: prep.customer.id,
          templateId: opts?.templateId ?? null,
          complaintId: opts?.complaintId ?? null,
          externalId: sentEmail.externalId,
          sentAt: now,
          deliveryStatus: MessageDeliveryStatus.SENT,
          deliveryUpdatedAt: now,
        },
      });
      return { messageId: msg.id, channel: prep.channel, externalId: sentEmail.externalId };
    }
    const ctx = prep.ctx as GhlTokenContext;
    let externalId: string | null;
    try {
      const contactId = await ensureContact(ctx, prep.customer);
      externalId = await sendGhlMessage(ctx, contactId, body, prep.channel);
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
        complaintId: opts?.complaintId ?? null,
        externalId,
        sentAt: new Date(),
      },
    });
    return { messageId: msg.id, channel: prep.channel, externalId };
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
  // throws, it is reported in `recipients`. With an explicit channel that cannot work, or no channel
  // at all, it fails up front (409 CHANNEL_UNAVAILABLE); otherwise each customer gets the best available channel
  // (SMS via GHL when connected, else email) or is skipped with a reason.
  const broadcast = async (
    targets: BroadcastTarget[],
    opts: {
      body: string;
      channel?: MessageChannel;
      templateId?: string | null;
      scheduledFor?: Date;
      reason: string;
      subject?: string;
      extraPayload?: Record<string, unknown>;
    }
  ): Promise<BroadcastResult> => {
    const caps = await getCaps();
    if (opts.channel) assertChannelUsable(opts.channel, caps);
    else assertAnyAvailable(caps);
    const recipients: BroadcastRecipient[] = [];

    for (const { customer, vars } of targets) {
      const base = { customerId: customer.id, customerName: customer.name };
      if (customer.messagesOptOut) {
        recipients.push({ ...base, status: "skipped_opted_out", reason: "CUSTOMER_OPTED_OUT" });
        continue;
      }

      let channel: MessageChannel;
      if (opts.channel) {
        try {
          channel = resolveChannel(customer, opts.channel);
        } catch (err) {
          recipients.push({ ...base, status: "skipped_no_contact", error: (err as Error).message });
          continue;
        }
        if (channel === MessageChannel.EMAIL && customer.emailInvalidAt) {
          recipients.push({ ...base, status: "skipped_no_channel", reason: "NO_AVAILABLE_CHANNEL", error: EMAIL_INVALID_MESSAGE });
          continue;
        }
      } else {
        const best = bestChannel({ ...customer, messagesOptOut: false }, undefined, caps);
        if ("skip" in best) {
          recipients.push({ ...base, status: "skipped_no_channel", reason: best.skip });
          continue;
        }
        channel = best.channel;
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
          await deliver({ customer, channel, ctx: caps.ctx }, body, { templateId: opts.templateId, subject: opts.subject });
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
      skippedNoChannel: count("skipped_no_channel"),
      failed: count("failed"),
      scheduledFor: opts.scheduledFor ? opts.scheduledFor.toISOString() : null,
      recipients,
    };
  };

  return {
    prepare,
    deliver,
    broadcast,
    /** 409 CHANNEL_UNAVAILABLE (NO_AVAILABLE_CHANNEL) when neither email nor GHL can send: lets callers fail before they change anything. */
    assertAnyChannelAvailable: async (): Promise<void> => {
      assertAnyAvailable(await getCaps());
    },

    /** Raw channel state (GHL connected? email availability) for per-customer routing in bulk flows. */
    channelCaps: async (): Promise<ChannelCaps> => {
      const caps = await getCaps();
      return { ghl: caps.ghl, email: caps.email };
    },

    /** Capability flags for the settings/bootstrap response. */
    capabilities: async () => {
      const caps = await getCaps();
      return { email: caps.email.available, sms: caps.ghl, whatsapp: caps.ghl, calls: true };
    },

    // Send one message to a customer (resolved by property or customer id). channel omitted = best available:
    // SMS (GHL, when the customer has a mobile) else EMAIL (native mailer).
    send: async (input: { propertyId?: string; customerId?: string; channel?: string; body: string; subject?: string; templateId?: string | null }) => {
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
      const sent = await deliver(prep, input.body, { templateId: input.templateId, subject: input.subject });
      return { status: "sent" as const, messageId: sent.messageId, channel: sent.channel };
    },

    // Automated one-off message (pre-clean reminder, visit completed, complaint reply): the preferred channel when it
    // can be used, else the best available one, else a skip with a reason. Never throws for "cannot reach".
    sendBest: async (input: {
      customerId: string;
      preferred?: string;
      body: string;
      subject?: string;
      templateId?: string | null;
      complaintId?: string | null;
    }) => {
      const customer = await prisma.customer.findUnique({ where: { id: input.customerId }, select: customerSelect });
      if (!customer) throw new AppError(404, "Customer not found");
      const caps = await getCaps();
      const best = bestChannel({ ...customer, messagesOptOut: customer.messagesOptOut }, input.preferred ? normaliseChannel(input.preferred) : undefined, caps);
      if ("skip" in best) return { status: "skipped" as const, reason: best.skip };
      const sent = await deliver(
        { customer, channel: best.channel, ctx: best.channel === MessageChannel.EMAIL ? null : caps.ctx },
        input.body,
        { templateId: input.templateId, subject: input.subject, complaintId: input.complaintId }
      );
      return { status: "sent" as const, messageId: sent.messageId, channel: sent.channel };
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
      // MSG-003b: the round and recipients are validated first (404 / 400); broadcast() then judges the channel.

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
