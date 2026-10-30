import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { MessageChannel, MessageDirection } from "../generated/tenant-client";
import { getGhlToken, createGhlContact, sendGhlMessage, GhlTokenContext } from "../integrations/ghl/api";

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

  return {
    prepare,
    deliver,

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

    // Broadcast one message to every customer in a round, right now (no scheduling).
    // excludePaymentHold drops any customer whose round properties all have a payment-hold visit.
    // Best-effort: a per-recipient failure is logged and skipped; `queued` counts successes.
    sendToRound: async (input: { roundId: string; channel: string; body: string; excludePaymentHold: boolean }) => {
      const channel = normaliseChannel(input.channel);
      const ctx = await requireGhl();

      const props = await prisma.property.findMany({
        where: { roundId: input.roundId },
        select: {
          customer: { select: customerSelect },
          visits: { where: { paymentHold: true }, select: { id: true }, take: 1 },
        },
      });

      const byCustomer = new Map<string, ContactCustomer>();
      for (const p of props) {
        if (input.excludePaymentHold && p.visits.length) continue;
        byCustomer.set(p.customer.id, p.customer);
      }

      let queued = 0;
      for (const c of byCustomer.values()) {
        try {
          const contactId = await ensureContact(ctx, c);
          await sendGhlMessage(ctx, contactId, input.body, channel);
          queued++;
        } catch (err) {
          console.error(`[messages] bulk send to customer ${c.id} failed:`, err);
        }
      }
      return { queued };
    },
  };
}
