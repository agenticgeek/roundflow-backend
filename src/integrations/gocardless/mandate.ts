import type { GcClient } from "./client.js";

// Direct Debit setup via GoCardless billing request flows: GoCardless hosts the whole sign-up, the link stays valid
// for days (so it can be emailed or texted), and the new mandate is reported back by the `billing_requests` webhook.
// Replaces redirect flows, which expire within minutes and need our own page to complete them.

/** Metadata key on the billing request that ties it back to the RoundFlow customer. */
export const RF_CUSTOMER_KEY = "roundflow_customer_id";

export interface MandateSetupLink {
  billingRequestId: string;
  url: string;
  expiresAt: Date | null;
}

function splitName(name: string): { given_name: string; family_name: string } {
  const trimmed = name.trim();
  const idx = trimmed.indexOf(" ");
  return idx === -1
    ? { given_name: trimmed, family_name: "" }
    : { given_name: trimmed.slice(0, idx), family_name: trimmed.slice(idx + 1).trim() };
}

/** Creates a Bacs mandate request plus its hosted flow, prefilled with what we know about the customer. */
export async function createMandateSetupLink(
  client: GcClient,
  customer: { id: string; name: string; email: string | null },
  description: string,
): Promise<MandateSetupLink> {
  const request = await client.billingRequests.create({
    mandate_request: { scheme: "bacs", description },
    metadata: { [RF_CUSTOMER_KEY]: customer.id },
  });
  const flow = await client.billingRequestFlows.create({
    links: { billing_request: request.id },
    prefilled_customer: { ...splitName(customer.name), ...(customer.email ? { email: customer.email } : {}) },
  });
  if (!flow.authorisation_url) throw new Error("GoCardless returned no authorisation url");
  return {
    billingRequestId: request.id,
    url: flow.authorisation_url,
    expiresAt: flow.expires_at ? new Date(flow.expires_at) : null,
  };
}

export interface FulfilledMandate {
  mandateId: string;
  gcCustomerId: string | null;
  rfCustomerId: string | null;
  status: string;
}

/** The mandate a fulfilled billing request produced (null when it produced none, e.g. a payment-only request). */
export async function getFulfilledMandate(client: GcClient, billingRequestId: string): Promise<FulfilledMandate | null> {
  const request = await client.billingRequests.find(billingRequestId);
  const mandateId = request.links?.mandate_request_mandate;
  if (!mandateId) return null;
  const mandate = await client.mandates.find(mandateId);
  const rfCustomerId = (request.metadata as Record<string, unknown> | undefined)?.[RF_CUSTOMER_KEY];
  return {
    mandateId,
    gcCustomerId: request.links?.customer ?? mandate.links?.customer ?? null,
    rfCustomerId: typeof rfCustomerId === "string" ? rfCustomerId : null,
    status: mandate.status ?? "pending_submission",
  };
}

export interface GcMandateSummary {
  mandateId: string;
  status: string;
  reference: string | null;
  createdAt: string | null;
  gcCustomerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
}

/** Mandates that can still collect money (live or on their way), each with its GoCardless customer's details. */
export async function listCollectableMandates(client: GcClient): Promise<GcMandateSummary[]> {
  const customers = new Map<string, Record<string, unknown>>();
  for await (const c of client.customers.all({ limit: 500 })) {
    if (c.id) customers.set(c.id, c as Record<string, unknown>);
  }
  const out: GcMandateSummary[] = [];
  for await (const m of client.mandates.all({ status: ["active", "pending_submission", "submitted"], limit: 500 })) {
    const gcCustomerId = m.links?.customer;
    if (!m.id || !gcCustomerId) continue;
    const c = customers.get(gcCustomerId) ?? {};
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
    const name =
      [str(c.given_name), str(c.family_name)].filter(Boolean).join(" ") || str(c.company_name) || "(no name)";
    out.push({
      mandateId: m.id,
      status: m.status ?? "active",
      reference: m.reference ?? null,
      createdAt: m.created_at ?? null,
      gcCustomerId,
      name,
      email: str(c.email),
      phone: str(c.phone_number),
      postcode: str(c.postal_code),
    });
  }
  return out;
}
