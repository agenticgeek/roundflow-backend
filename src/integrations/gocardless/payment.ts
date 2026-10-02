import type { GcClient } from "./client.js";

export async function createGcPayment(
  client: GcClient,
  opts: {
    mandateId: string;
    amountPence: number;
    description: string;
    reference: string;
    metadata?: Record<string, string>;
  }
): Promise<{ id: string; status: string }> {
  const payment = await client.payments.create({
    amount: opts.amountPence,
    currency: "GBP",
    description: opts.description,
    reference: opts.reference,
    links: { mandate: opts.mandateId },
    metadata: opts.metadata,
  });
  return { id: payment.id!, status: payment.status! };
}
