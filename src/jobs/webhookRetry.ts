import type Stripe from "stripe";
import { prisma } from "../lib/prisma";
import { forEachTenant } from "../lib/tenant-jobs";
import { sweepWebhookEvents } from "../services/webhook-events.service";
import { handleStripeEvent } from "../routes/stripeWebhook";
import { handleGocardlessEvent, type GcEvent } from "../routes/gocardlessWebhook";
import { handleGhlEvent, type GhlEvent } from "../routes/ghlWebhook";
import { handleSesPayload } from "../routes/sesWebhook";

// BE-03: retry sweep for webhook events whose effect failed (status FAILED) or was abandoned (RECEIVED but never
// finished, e.g. the process was killed). Every 2 minutes; per-row exponential backoff and a max of 8 attempts live
// in services/webhook-events.service.ts. Safe to run on every instance: handlers are idempotent and the effect is
// guarded by the payment state machine.
export async function runWebhookRetry(): Promise<void> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, schemaName: true } });
  // BUG-010: bounded concurrency through the shared client cache (one Prisma client per tenant at once exhausted
  // Postgres connections with ~90 tenants).
  const results = await forEachTenant(
    tenants,
    async (tp, t) => {
      const res = await sweepWebhookEvents(tp, {
        stripe: (payload) => handleStripeEvent(tp, t.id, payload as Stripe.Event),
        gocardless: (payload) => handleGocardlessEvent(tp, payload as GcEvent),
        ghl: (payload) => handleGhlEvent(t.schemaName, payload as GhlEvent),
        ses: (payload) => handleSesPayload(tp, payload),
      });
      if (res.retried > 0) console.log(`[webhookRetry] ${t.schemaName}: retried ${res.retried}, done ${res.done}, failed ${res.failed}`);
    }
  );
  for (const r of results) {
    if (r.status === "rejected") console.error("[webhookRetry] tenant sweep failed:", r.reason);
  }
}
