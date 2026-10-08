import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { getGhlToken, createGhlContact, sendGhlMessage, GhlTokenContext } from "../integrations/ghl/api";

const CHANNELS = new Set(["sms", "email", "whatsapp"]);

type ContactCustomer = { id: string; name: string; phone: string | null; email: string | null; ghlContactId: string | null };

function assertChannel(channel: string) {
  if (!CHANNELS.has(channel.toLowerCase())) {
    throw new AppError(400, `channel must be one of: ${[...CHANNELS].join(", ")}`);
  }
}

export function createMessageService(prisma: TenantPrismaClient) {
  // Resolve (creating + persisting if missing) the GHL contact id for a customer.
  const ensureContact = async (ctx: GhlTokenContext, c: ContactCustomer): Promise<string> => {
    if (c.ghlContactId) return c.ghlContactId;
    const contactId = await createGhlContact(ctx, c);
    await prisma.customer.update({ where: { id: c.id }, data: { ghlContactId: contactId } });
    return contactId;
  };

  return {
    // Send one message to a customer (resolved by property or customer id) via GHL.
    // Mirrors the direct-send path used for complaint replies (sync.ts).
    send: async (input: { propertyId?: string; customerId?: string; channel: string; body: string }) => {
      assertChannel(input.channel);

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

      const ctx = await getGhlToken(prisma);
      if (!ctx) throw new AppError(409, "GoHighLevel is not connected");

      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, phone: true, email: true, ghlContactId: true },
      });
      if (!customer) throw new AppError(404, "Customer not found");

      const contactId = await ensureContact(ctx, customer);
      await sendGhlMessage(ctx, contactId, input.body, input.channel.toUpperCase());
      return { status: "sent" as const };
    },

    // Broadcast one message to every customer in a round, right now (no scheduling).
    // excludePaymentHold drops any customer whose round properties all have a payment-hold visit.
    // Best-effort: a per-recipient failure is logged and skipped; `queued` counts successes.
    sendToRound: async (input: { roundId: string; channel: string; body: string; excludePaymentHold: boolean }) => {
      assertChannel(input.channel);

      const ctx = await getGhlToken(prisma);
      if (!ctx) throw new AppError(409, "GoHighLevel is not connected");

      const props = await prisma.property.findMany({
        where: { roundId: input.roundId },
        select: {
          customer: { select: { id: true, name: true, phone: true, email: true, ghlContactId: true } },
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
          await sendGhlMessage(ctx, contactId, input.body, input.channel.toUpperCase());
          queued++;
        } catch (err) {
          console.error(`[messages] bulk send to customer ${c.id} failed:`, err);
        }
      }
      return { queued };
    },
  };
}
