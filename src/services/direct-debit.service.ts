import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { decrypt } from "../lib/crypto";
import { getGcClient, type GcClient } from "../integrations/gocardless/client";
import {
  createMandateSetupLink,
  getFulfilledMandate,
  listCollectableMandates,
  type GcMandateSummary,
} from "../integrations/gocardless/mandate";
import { createMessageService } from "./message.service";
import { FALLBACK_BODIES, TEMPLATE_NAMES, loadTemplate, renderTemplate } from "./message-templates";
import { getCachedBusinessSettings } from "./settings.service";

// Direct Debit setup links and mandate linking (GoCardless). A customer is sent a hosted GoCardless sign-up link; when
// they finish it, the `billing_requests.fulfilled` webhook links the new mandate here and the usual mandate events move
// it to active. Mandates set up before RoundFlow can be linked in bulk with importCandidates() + importMandates().

/** Mandate statuses that already cover the customer: no new setup link is made for them. */
export const MANDATE_IN_PLACE = new Set(["active", "pending_customer_approval", "pending_submission", "submitted"]);
/** An automatic link (technician chose Direct Debit) is not re-sent within this window. */
export const AUTO_RESEND_GAP_MS = 7 * 24 * 60 * 60 * 1000;
/** A stored link is reused while it has at least this long left. */
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;

export const DD_SETUP_LINK_EVENT = "dd.setup_link";

export type DdSkipReason = "GOCARDLESS_NOT_CONNECTED" | "MANDATE_EXISTS" | "RECENTLY_SENT" | "NO_AVAILABLE_CHANNEL" | "CUSTOMER_OPTED_OUT";

type Actor = { id?: string | null; role?: string | null };

/** The tenant's GoCardless API client, or null when GoCardless is not connected. */
export async function getTenantGcClient(tp: TenantPrismaClient): Promise<GcClient | null> {
  const bs = await tp.businessSettings.findFirst({
    select: { gocardlessConnected: true, gocardlessAccessTokenEncrypted: true, gocardlessEnvironment: true },
  });
  if (!bs?.gocardlessConnected || !bs.gocardlessAccessTokenEncrypted) return null;
  return getGcClient(decrypt(bs.gocardlessAccessTokenEncrypted), bs.gocardlessEnvironment ?? "sandbox");
}

/**
 * Queues an automated setup-link send (outbox, so the caller never waits on GoCardless or the mailer).
 * "not_connected" / "mandate_exists" = nothing was queued.
 */
export async function queueDdSetupLink(
  tp: TenantPrismaClient,
  customerId: string,
): Promise<"queued" | "not_connected" | "mandate_exists"> {
  const [settings, customer] = await Promise.all([
    getCachedBusinessSettings(tp),
    tp.customer.findUnique({ where: { id: customerId }, select: { gocardlessMandateStatus: true } }),
  ]);
  if (!settings?.gocardlessConnected) return "not_connected";
  if (customer?.gocardlessMandateStatus && MANDATE_IN_PLACE.has(customer.gocardlessMandateStatus)) return "mandate_exists";
  await tp.integrationOutbox.create({ data: { eventType: DD_SETUP_LINK_EVENT, payload: { customerId } } });
  return "queued";
}

const normEmail =(v: string | null | undefined) => (v ? v.trim().toLowerCase() || null : null);
/** UK-friendly phone key: digits only, +44/0044 folded to a leading 0. */
export function normPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  let d = v.replace(/\D/g, "");
  if (d.startsWith("0044")) d = "0" + d.slice(4);
  else if (d.startsWith("44")) d = "0" + d.slice(2);
  return d.length >= 9 ? d : null;
}

export interface ImportCandidate extends GcMandateSummary {
  /** RoundFlow customer this mandate is already linked to, if any. */
  linkedCustomerId: string | null;
  /** Suggested RoundFlow customer (unique email match, else unique phone match). */
  suggestion: { customerId: string; customerName: string; matchedBy: "email" | "phone" } | null;
  /** More than one RoundFlow customer matched, so nothing is suggested. */
  ambiguous: boolean;
}

export function createDirectDebitService(tp: TenantPrismaClient, actor: Actor = {}) {
  const log = (type: string, message: string, entityId: string, details?: Record<string, unknown>) =>
    tp.activityLog.create({
      data: { type, message, entityId, actorId: actor.id ?? null, actorRole: actor.role ?? null, ...(details ? { details: details as object } : {}) },
    });

  const loadCustomer = async (customerId: string) => {
    const customer = await tp.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true, name: true, email: true,
        gocardlessMandateId: true, gocardlessMandateStatus: true,
        ddSetupLinkUrl: true, ddSetupLinkSentAt: true, ddSetupLinkExpiresAt: true,
      },
    });
    if (!customer) throw new AppError(404, "Customer not found");
    return customer;
  };

  const requireClient = async () => {
    const client = await getTenantGcClient(tp);
    if (!client) throw new AppError(409, "GoCardless is not connected. Connect it in Settings > Payments first.", "GOCARDLESS_NOT_CONNECTED");
    return client;
  };

  const assertNoMandate = (c: { gocardlessMandateStatus: string | null }) => {
    if (c.gocardlessMandateStatus && MANDATE_IN_PLACE.has(c.gocardlessMandateStatus)) {
      throw new AppError(409, "This customer already has a Direct Debit set up.", "MANDATE_EXISTS");
    }
  };

  /** The customer's current setup link, made (and stored) if there is no usable one. */
  const getOrCreateLink = async (customerId: string, opts: { fresh?: boolean } = {}) => {
    const customer = await loadCustomer(customerId);
    assertNoMandate(customer);
    const client = await requireClient();
    const now = Date.now();
    if (
      !opts.fresh &&
      customer.ddSetupLinkUrl &&
      customer.ddSetupLinkExpiresAt &&
      customer.ddSetupLinkExpiresAt.getTime() - now > REUSE_MIN_REMAINING_MS
    ) {
      return { url: customer.ddSetupLinkUrl, expiresAt: customer.ddSetupLinkExpiresAt };
    }
    const settings = await getCachedBusinessSettings(tp);
    const link = await createMandateSetupLink(
      client,
      customer,
      `Direct Debit for ${settings?.businessName?.trim() || "window cleaning"}`,
    );
    await tp.customer.update({
      where: { id: customer.id },
      data: { gocardlessBillingRequestId: link.billingRequestId, ddSetupLinkUrl: link.url, ddSetupLinkExpiresAt: link.expiresAt },
    });
    return { url: link.url, expiresAt: link.expiresAt };
  };

  const renderMessage = async (customerName: string, url: string) => {
    const [settings, template] = await Promise.all([
      getCachedBusinessSettings(tp),
      loadTemplate(tp, TEMPLATE_NAMES.DD_SETUP_LINK, FALLBACK_BODIES.DD_SETUP_LINK),
    ]);
    const vars = {
      customerName,
      firstName: customerName.split(" ")[0],
      businessName: settings?.businessName ?? "",
      paymentLink: url,
    };
    return {
      body: renderTemplate(template.body, vars),
      subject: template.subject ? renderTemplate(template.subject, vars) : "Set up your Direct Debit",
      templateId: template.id,
    };
  };

  return {
    /** Direct Debit state for the customer screen. */
    async status(customerId: string) {
      const customer = await loadCustomer(customerId);
      const settings = await getCachedBusinessSettings(tp);
      const linkLive = !!customer.ddSetupLinkUrl && !!customer.ddSetupLinkExpiresAt && customer.ddSetupLinkExpiresAt.getTime() > Date.now();
      return {
        gocardlessConnected: !!settings?.gocardlessConnected,
        mandateStatus: customer.gocardlessMandateStatus,
        mandateId: customer.gocardlessMandateId,
        linkSentAt: customer.ddSetupLinkSentAt,
        linkUrl: linkLive ? customer.ddSetupLinkUrl : null,
        linkExpiresAt: linkLive ? customer.ddSetupLinkExpiresAt : null,
      };
    },

    /** Office: the setup link to copy (no message sent). */
    async link(customerId: string) {
      return getOrCreateLink(customerId);
    },

    /**
     * Sends the setup link. Office sends (automated false) throw a typed 404/409 when it cannot go out and use the
     * chosen channel (or the best one). Automated sends (technician chose Direct Debit, setup wizard) never throw for
     * "cannot send": they return a skip reason, honour opt-out, and are not repeated within AUTO_RESEND_GAP_MS.
     */
    async sendLink(
      customerId: string,
      opts: { channel?: string; automated?: boolean } = {},
    ): Promise<{ status: "sent"; channel: string; url: string; expiresAt: Date | null } | { status: "skipped"; reason: DdSkipReason }> {
      if (opts.automated) {
        const customer = await loadCustomer(customerId);
        if (customer.gocardlessMandateStatus && MANDATE_IN_PLACE.has(customer.gocardlessMandateStatus)) {
          return { status: "skipped", reason: "MANDATE_EXISTS" };
        }
        if (customer.ddSetupLinkSentAt && Date.now() - customer.ddSetupLinkSentAt.getTime() < AUTO_RESEND_GAP_MS) {
          return { status: "skipped", reason: "RECENTLY_SENT" };
        }
        if (!(await getTenantGcClient(tp))) return { status: "skipped", reason: "GOCARDLESS_NOT_CONNECTED" };
      }
      const customer = await loadCustomer(customerId);
      const link = await getOrCreateLink(customerId);
      const msg = await renderMessage(customer.name, link.url);
      const messages = createMessageService(tp);
      let channel: string;
      if (opts.automated) {
        const res = await messages.sendBest({ customerId, body: msg.body, subject: msg.subject, templateId: msg.templateId });
        if (res.status === "skipped") return { status: "skipped", reason: res.reason };
        channel = res.channel;
      } else {
        const res = await messages.send({ customerId, channel: opts.channel, body: msg.body, subject: msg.subject, templateId: msg.templateId });
        channel = res.channel;
      }
      await tp.customer.update({ where: { id: customerId }, data: { ddSetupLinkSentAt: new Date() } });
      await log("DD_SETUP_LINK_SENT", `Direct Debit setup link sent to ${customer.name} by ${channel.toLowerCase()}`, customerId, {
        channel,
        automated: !!opts.automated,
      });
      return { status: "sent", channel, url: link.url, expiresAt: link.expiresAt };
    },

    /** Webhook: a billing request was fulfilled; link the mandate it produced to the customer it was made for. */
    async handleBillingRequestFulfilled(billingRequestId: string): Promise<void> {
      const client = await getTenantGcClient(tp);
      if (!client) return;
      const fulfilled = await getFulfilledMandate(client, billingRequestId);
      if (!fulfilled) return;
      const customer =
        (await tp.customer.findUnique({ where: { gocardlessBillingRequestId: billingRequestId }, select: { id: true, name: true } })) ??
        (fulfilled.rfCustomerId
          ? await tp.customer.findUnique({ where: { id: fulfilled.rfCustomerId }, select: { id: true, name: true } })
          : null);
      if (!customer) return;
      await tp.customer.update({
        where: { id: customer.id },
        data: {
          gocardlessMandateId: fulfilled.mandateId,
          gocardlessCustomerId: fulfilled.gcCustomerId,
          gocardlessMandateStatus: fulfilled.status,
          ddSetupLinkUrl: null,
          ddSetupLinkExpiresAt: null,
        },
      });
      await log("DIRECT_DEBIT_SET_UP", `${customer.name} set up a Direct Debit (GoCardless mandate ${fulfilled.mandateId})`, customer.id);
    },

    /** Existing GoCardless mandates with a suggested RoundFlow customer for each (nothing is linked here). */
    async importCandidates(): Promise<{ rows: ImportCandidate[] }> {
      const client = await requireClient();
      const [mandates, customers] = await Promise.all([
        listCollectableMandates(client),
        tp.customer.findMany({ select: { id: true, name: true, email: true, phone: true, gocardlessMandateId: true } }),
      ]);
      const byEmail = new Map<string, typeof customers>();
      const byPhone = new Map<string, typeof customers>();
      const linked = new Map<string, string>();
      for (const c of customers) {
        const e = normEmail(c.email);
        const p = normPhone(c.phone);
        if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
        if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), c]);
        if (c.gocardlessMandateId) linked.set(c.gocardlessMandateId, c.id);
      }
      const rows = mandates.map((m): ImportCandidate => {
        const emailHits = byEmail.get(normEmail(m.email) ?? "") ?? [];
        const phoneHits = byPhone.get(normPhone(m.phone) ?? "") ?? [];
        const hits = emailHits.length ? emailHits : phoneHits;
        const matchedBy = emailHits.length ? "email" : "phone";
        return {
          ...m,
          linkedCustomerId: linked.get(m.mandateId) ?? null,
          suggestion: hits.length === 1 ? { customerId: hits[0].id, customerName: hits[0].name, matchedBy } : null,
          ambiguous: hits.length > 1,
        };
      });
      return { rows };
    },

    /** Links the confirmed mandate -> customer pairs. Each pair is checked against GoCardless and RoundFlow first. */
    async importMandates(pairs: Array<{ mandateId: string; customerId: string }>) {
      const client = await requireClient();
      const mandates = new Map((await listCollectableMandates(client)).map((m) => [m.mandateId, m]));
      const seenCustomers = new Set<string>();
      const results: Array<{ mandateId: string; customerId: string; status: "linked" | "failed"; error?: string }> = [];
      for (const { mandateId, customerId } of pairs) {
        const fail = (error: string) => results.push({ mandateId, customerId, status: "failed", error });
        const m = mandates.get(mandateId);
        if (!m) { fail("Mandate not found in GoCardless, or it can no longer collect"); continue; }
        if (seenCustomers.has(customerId)) { fail("Customer chosen for more than one mandate"); continue; }
        const customer = await tp.customer.findUnique({
          where: { id: customerId },
          select: { id: true, name: true, gocardlessMandateId: true, gocardlessMandateStatus: true },
        });
        if (!customer) { fail("Customer not found"); continue; }
        if (
          customer.gocardlessMandateId &&
          customer.gocardlessMandateId !== mandateId &&
          customer.gocardlessMandateStatus &&
          MANDATE_IN_PLACE.has(customer.gocardlessMandateStatus)
        ) {
          fail(`${customer.name} already has another Direct Debit`); continue;
        }
        const owner = await tp.customer.findFirst({ where: { gocardlessMandateId: mandateId, id: { not: customerId } }, select: { name: true } });
        if (owner) { fail(`Mandate is already linked to ${owner.name}`); continue; }
        await tp.customer.update({
          where: { id: customerId },
          data: { gocardlessMandateId: mandateId, gocardlessCustomerId: m.gcCustomerId, gocardlessMandateStatus: m.status },
        });
        seenCustomers.add(customerId);
        await log("DIRECT_DEBIT_LINKED", `Existing GoCardless mandate ${mandateId} linked to ${customer.name}`, customerId);
        results.push({ mandateId, customerId, status: "linked" });
      }
      return { linked: results.filter((r) => r.status === "linked").length, failed: results.filter((r) => r.status === "failed").length, results };
    },
  };
}
