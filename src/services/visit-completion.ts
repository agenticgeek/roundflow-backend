import { InvoiceStatus, LifecycleStatus, PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../generated/tenant-client";
import { nextDueAfter } from "../lib/schedule";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { TEMPLATE_NAMES } from "./message-templates";
import { getCachedBusinessSettings } from "./settings.service";
import { createInvoiceService } from "./invoice.service";
import { grossOf, round2 } from "../lib/vat";
import { visitLabelFrom } from "../lib/activity-labels";
import { DD_SETUP_LINK_EVENT, MANDATE_IN_PLACE } from "./direct-debit.service";
import { isOpenVisit, STOP_ORDER, stopStatus, stopWhere } from "./stops";
import { notifyAdmins } from "./notify";

// Shared visit completion used by PATCH /visits/:id/complete (web) and
// PATCH /mobile/visits/:id/complete (technician app).
//
// D-2: all payment input is validated, and any GoCardless charge is created,
// BEFORE anything is written. The visit status, Payment row, cheque log and
// outbox events are then written in ONE transaction, so a 400 leaves the visit
// untouched and a retry works.

export type CompletionPaymentMethod = "CASH" | "CHEQUE" | "BACS" | "GOCARDLESS" | "STRIPE" | "NONE";

export interface CompletionPaymentInput {
  method: CompletionPaymentMethod;
  amount?: number;
  chequeNumber?: string;
  /** App extra: the method the technician picked when `method` is NONE (alias of the chosen method). */
  collectVia?: Exclude<CompletionPaymentMethod, "NONE">;
  /** Also make `method` (or collectVia) the customer's usual payment method. */
  updateCustomerDefault?: boolean;
}

/** One service of a stop in a stop completion: done, or not done with the reason. */
export interface StopServiceInput {
  visitId: string;
  done: boolean;
  skipReason?: string;
}

export interface CompleteVisitOptions {
  payment?: CompletionPaymentInput;
  note?: string;
  actorProfileId?: string;
  actorRole?: string;
  /** Complete (or skip) these services of the visit's stop in one go (docs/PROPERTY_STOPS_PLAN_2026-11-19.md §7.3). */
  services?: StopServiceInput[];
}

export interface CompleteVisitResult {
  id: string;
  status: VisitStatus;
  payment: { id: string; method: PaymentMethod; status: PaymentStatus; amount: number } | null;
  // A1: the invoice created automatically at completion (null when none was
  // created: customer/visit on payment hold, already invoiced, or a
  // best-effort failure — the office can still invoice the visit by hand).
  invoice: { id: string; status: InvoiceStatus } | null;
  // Direct Debit was the method but the customer has no mandate yet, so nothing was collected and a GoCardless setup
  // link was queued for them (sent by the outbox worker). Absent/false otherwise.
  directDebitSetupLinkQueued?: boolean;
  /** Stop completion only: every service in the stop after the call. */
  services?: Array<{ visitId: string; status: VisitStatus }>;
  /** Stop completion only: listed services that were no longer open (done, skipped, moved or cancelled meanwhile). */
  ignored?: string[];
}

// Outbox event for the "Visit completed" customer message (A5). The outbox
// worker (src/jobs/outboxWorker.ts) renders the tenant's "Visit completed"
// MessageTemplate (built-in fallback body when absent) and sends it via GHL.
export const VISIT_COMPLETED_MESSAGE_EVENT = "message.visit_completed";
export const VISIT_COMPLETED_TEMPLATE_NAME = TEMPLATE_NAMES.VISIT_COMPLETED;

const METHODS: readonly CompletionPaymentMethod[] = ["CASH", "CHEQUE", "BACS", "GOCARDLESS", "STRIPE", "NONE"];
const REAL_METHODS = METHODS.filter((m) => m !== "NONE") as Array<Exclude<CompletionPaymentMethod, "NONE">>;
const MAX_CHEQUE_NUMBER_LENGTH = 50;
const MAX_AMOUNT = 9999.99;

// Parse `payment` (+ the deprecated `cashConfirmed: true` alias for CASH) from a
// request body. Returns undefined when neither is sent.
export function parseCompletionPayment(body: Record<string, unknown>): CompletionPaymentInput | undefined {
  const raw = body.payment;
  if (raw === undefined || raw === null) {
    if (body.cashConfirmed !== undefined && typeof body.cashConfirmed !== "boolean") {
      throw new AppError(400, `"cashConfirmed" must be a boolean.`);
    }
    return body.cashConfirmed === true ? { method: "CASH" } : undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, `"payment" must be an object.`, "INVALID_PAYMENT");
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.method !== "string" || !METHODS.includes(p.method as CompletionPaymentMethod)) {
    throw new AppError(400, `"payment.method" must be one of: ${METHODS.join(", ")}`, "INVALID_PAYMENT");
  }
  const method = p.method as CompletionPaymentMethod;

  let amount: number | undefined;
  if (p.amount !== undefined && p.amount !== null) {
    if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount <= 0 || p.amount > MAX_AMOUNT) {
      throw new AppError(400, `"payment.amount" must be a number > 0 and ≤ ${MAX_AMOUNT}`, "INVALID_PAYMENT");
    }
    amount = Math.round(p.amount * 100) / 100;
  }

  let chequeNumber: string | undefined;
  if (p.chequeNumber !== undefined && p.chequeNumber !== null) {
    if (typeof p.chequeNumber !== "string" || p.chequeNumber.length > MAX_CHEQUE_NUMBER_LENGTH) {
      throw new AppError(400, `"payment.chequeNumber" must be a string of at most ${MAX_CHEQUE_NUMBER_LENGTH} characters`, "INVALID_PAYMENT");
    }
    chequeNumber = p.chequeNumber.trim() || undefined;
  }
  if (method === "CHEQUE" && !chequeNumber) {
    throw new AppError(400, `"payment.chequeNumber" is required for cheque payments`, "CHEQUE_NUMBER_REQUIRED");
  }

  let collectVia: CompletionPaymentInput["collectVia"];
  if (p.collectVia !== undefined && p.collectVia !== null) {
    if (typeof p.collectVia !== "string" || !REAL_METHODS.includes(p.collectVia as never)) {
      throw new AppError(400, `"payment.collectVia" must be one of: ${REAL_METHODS.join(", ")}`, "INVALID_PAYMENT");
    }
    collectVia = p.collectVia as CompletionPaymentInput["collectVia"];
  }
  if (p.updateCustomerDefault !== undefined && typeof p.updateCustomerDefault !== "boolean") {
    throw new AppError(400, `"payment.updateCustomerDefault" must be a boolean`, "INVALID_PAYMENT");
  }

  return { method, amount, chequeNumber, collectVia, updateCustomerDefault: p.updateCustomerDefault as boolean | undefined };
}

const MAX_STOP_SERVICES = 20;
const MAX_SKIP_REASON_LENGTH = 200;

const invalidServices = (detail: string) => new AppError(400, `"services" ${detail}`, "INVALID_SERVICES");

// Parse `services` from a completion body. Undefined when it is not sent (single-visit completion).
export function parseStopServices(body: Record<string, unknown>): StopServiceInput[] | undefined {
  const raw = body.services;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STOP_SERVICES) {
    throw invalidServices(`must be a list of 1 to ${MAX_STOP_SERVICES} services`);
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidServices(`[${i}] must be an object`);
    const s = item as Record<string, unknown>;
    const visitId = typeof s.visitId === "string" ? s.visitId.trim() : "";
    if (!visitId) throw invalidServices(`[${i}].visitId is required`);
    if (seen.has(visitId)) throw invalidServices(`lists ${visitId} twice`);
    seen.add(visitId);
    if (typeof s.done !== "boolean") throw invalidServices(`[${i}].done must be true or false`);
    if (s.done) return { visitId, done: true };
    const reason = typeof s.skipReason === "string" ? s.skipReason.trim() : "";
    if (!reason || reason.length > MAX_SKIP_REASON_LENGTH) {
      throw invalidServices(`[${i}].skipReason is required for a service not done (at most ${MAX_SKIP_REASON_LENGTH} characters)`);
    }
    return { visitId, done: false, skipReason: reason };
  });
}

const DEFAULT_SERVICE_NAME = "Window clean";

type PlannedPayment = {
  method: PaymentMethod;
  status: PaymentStatus;
  amount: Prisma.Decimal | number;
  gocardlessId?: string;
  chequeNumber?: string;
};

// Collect by Direct Debit from an active mandate, before anything is written. Null when GoCardless has no token.
async function chargeGoCardless(
  tp: TenantPrismaClient,
  p: { mandateId: string; amount: number; description: string; visitId: string; customerId: string },
): Promise<string | null> {
  const bs = await tp.businessSettings.findFirst({
    select: { gocardlessAccessTokenEncrypted: true, gocardlessEnvironment: true },
  });
  if (!bs?.gocardlessAccessTokenEncrypted) return null;
  const { decrypt } = await import("../lib/crypto.js");
  const { getGcClient } = await import("../integrations/gocardless/client.js");
  const { createGcPayment } = await import("../integrations/gocardless/payment.js");
  const client = getGcClient(decrypt(bs.gocardlessAccessTokenEncrypted), bs.gocardlessEnvironment ?? "sandbox");
  const gcPayment = await createGcPayment(client, {
    mandateId: p.mandateId,
    amountPence: Math.round(p.amount * 100),
    description: p.description,
    reference: p.visitId.slice(-8).toUpperCase(),
    metadata: { visitId: p.visitId, customerId: p.customerId },
  });
  return gcPayment.id;
}

const stopVisitInclude = {
  property: { include: { customer: true } },
  servicePlan: true,
  payment: true,
  service: { select: { name: true } },
} satisfies Prisma.VisitInclude;
type StopVisit = Prisma.VisitGetPayload<{ include: typeof stopVisitInclude }>;

export function createVisitCompletionService(tp: TenantPrismaClient) {
  // A6 / GEN-001: the plan's "last completed" date, and one cycle ahead when its next due date is not already in the
  // future. A one-off visit (no servicePlanId) completes the property's ACTIVE plan. The update is returned wrapped
  // ({ op }) and NOT awaited: an async function would otherwise run the query at once, outside the transaction.
  async function planUpdate(visit: Pick<StopVisit, "servicePlan" | "servicePlanId" | "propertyId" | "date" | "roundId">, now: Date) {
    const plan = visit.servicePlan ?? (visit.servicePlanId ? null : await tp.servicePlan.findFirst({
      where: { propertyId: visit.propertyId, status: LifecycleStatus.ACTIVE },
      orderBy: { createdAt: "asc" },
    }));
    const planId = visit.servicePlanId ?? plan?.id;
    if (!planId) return null;
    const data: Prisma.ServicePlanUpdateInput = { lastCompleted: now };
    if (plan?.cleaningFrequency && (!plan.nextDueDate || plan.nextDueDate <= visit.date)) {
      const round = visit.roundId ? await tp.round.findUnique({ where: { id: visit.roundId }, select: { defaultDay: true } }) : null;
      data.nextDueDate = nextDueAfter(visit.date, plan.cleaningFrequency, round?.defaultDay);
    }
    return { op: tp.servicePlan.update({ where: { id: planId }, data }) };
  }

  // One stop (same property, day and technician) completed in one go: every done service is COMPLETED, every
  // unticked one SKIPPED with its reason (its plan untouched, so it comes round next cycle); one payment for the
  // total on the first done visit (the anchor), the others point at it (billedWithVisitId); one customer message;
  // one invoice with a line per service (after commit). Listed services that are no longer open are ignored.
  async function completeStop(visitId: string, opts: CompleteVisitOptions & { services: StopServiceInput[] }): Promise<CompleteVisitResult> {
    const visit = await tp.visit.findUnique({ where: { id: visitId }, include: stopVisitInclude });
    if (!visit) throw new AppError(404, "Visit not found");
    const stop: StopVisit[] = await tp.visit.findMany({ where: stopWhere(visit), include: stopVisitInclude, orderBy: STOP_ORDER });
    const byId = new Map(stop.map((v) => [v.id, v]));

    // A listed visit outside the stop is fine when the office moved or cancelled it meanwhile (same property);
    // anything else is a client error.
    const ignored: string[] = [];
    for (const s of opts.services) {
      const v = byId.get(s.visitId);
      if (v) {
        if (!isOpenVisit(v.status)) ignored.push(s.visitId);
        continue;
      }
      const other = await tp.visit.findUnique({ where: { id: s.visitId }, select: { propertyId: true } });
      if (other?.propertyId !== visit.propertyId) {
        throw new AppError(400, `Visit ${s.visitId} is not part of this stop`, "NOT_IN_STOP");
      }
      ignored.push(s.visitId);
    }
    const listed = new Map(opts.services.map((s) => [s.visitId, s]));
    const open = stop.filter((v) => isOpenVisit(v.status) && listed.has(v.id));
    const done = open.filter((v) => listed.get(v.id)!.done);
    const skipped = open.filter((v) => !listed.get(v.id)!.done);
    const after = (v: StopVisit): VisitStatus =>
      done.includes(v) ? VisitStatus.COMPLETED : skipped.includes(v) ? VisitStatus.SKIPPED : v.status;
    const servicesAfter = () => stop.map((v) => ({ visitId: v.id, status: after(v) }));

    if (open.length === 0) {
      return { id: visitId, status: stopStatus(stop.map(after)), payment: null, invoice: null, services: servicesAfter(), ignored };
    }

    const anchor = done[0] ?? null;
    const customer = (anchor ?? visit).property.customer;
    const customerId = customer.id;
    const input = opts.payment;
    const chosen = (input && input.method !== "NONE" ? input.method : input?.collectVia) as PaymentMethod | undefined;
    const offSite = chosen === PaymentMethod.BACS || chosen === PaymentMethod.GOCARDLESS || chosen === PaymentMethod.STRIPE;
    const lead = anchor ?? visit;
    const effectiveMethod =
      (offSite ? chosen : (lead.paymentMethod ?? lead.servicePlan?.paymentMethod ?? customer.paymentMethod)) as PaymentMethod | null;
    const settings = await getCachedBusinessSettings(tp);
    // VAT per service, then summed: the same figures the invoice lines will show.
    const gross = round2(done.reduce((sum, v) => sum + grossOf(v.price.toNumber(), settings), 0));
    const queueDdSetupLink =
      !!anchor &&
      effectiveMethod === PaymentMethod.GOCARDLESS &&
      !!settings?.gocardlessConnected &&
      !(customer.gocardlessMandateStatus && MANDATE_IN_PLACE.has(customer.gocardlessMandateStatus));

    // ---- 1. Decide the payment (validation and any external charge, no writes) ----
    let planned: PlannedPayment | null = null;
    if (anchor && !done.some((v) => v.payment)) {
      if (input?.method === "CASH") {
        planned = { method: PaymentMethod.CASH, status: PaymentStatus.PAID, amount: input.amount ?? gross };
      } else if (input?.method === "CHEQUE") {
        planned = { method: PaymentMethod.CHEQUE, status: PaymentStatus.PENDING, amount: input.amount ?? gross, chequeNumber: input.chequeNumber };
      } else if (effectiveMethod === PaymentMethod.CASH) {
        throw new AppError(
          400,
          'Cash payment must be confirmed: send payment { method: "CASH" } (or cashConfirmed: true)',
          "PAYMENT_CONFIRMATION_REQUIRED",
        );
      } else if (effectiveMethod === PaymentMethod.BACS || effectiveMethod === PaymentMethod.CHEQUE) {
        planned = { method: effectiveMethod, status: PaymentStatus.PENDING, amount: gross };
      } else if (effectiveMethod === PaymentMethod.GOCARDLESS && customer.gocardlessMandateId && customer.gocardlessMandateStatus === "active") {
        const gocardlessId = await chargeGoCardless(tp, {
          mandateId: customer.gocardlessMandateId,
          amount: gross,
          description: `Window cleaning — ${done.length} service${done.length === 1 ? "" : "s"} on ${anchor.date.toISOString().slice(0, 10)}`,
          visitId: anchor.id,
          customerId,
        });
        if (gocardlessId) planned = { method: PaymentMethod.GOCARDLESS, status: PaymentStatus.PENDING, amount: gross, gocardlessId };
      }
    }

    // ---- 2. One transaction for every write ----
    const now = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const v of done) {
      ops.push(
        tp.visit.update({
          where: { id: v.id },
          data: {
            status: VisitStatus.COMPLETED,
            completedAt: now,
            ...(chosen ? { collectedVia: chosen } : {}),
            ...(v !== anchor ? { billedWithVisitId: anchor!.id } : {}),
          },
        }),
      );
    }
    for (const v of skipped) {
      ops.push(tp.visit.update({ where: { id: v.id }, data: { status: VisitStatus.SKIPPED, skipReason: listed.get(v.id)!.skipReason } }));
    }
    let paymentIndex = -1;
    if (anchor && planned) {
      paymentIndex = ops.length;
      ops.push(
        tp.payment.create({
          data: {
            customerId,
            visitId: anchor.id,
            amount: planned.amount,
            method: planned.method,
            status: planned.status,
            ...(planned.status === PaymentStatus.PAID ? { paidAt: now } : {}),
            ...(planned.gocardlessId ? { gocardlessId: planned.gocardlessId } : {}),
            ...(planned.chequeNumber ? { reference: planned.chequeNumber } : {}),
          },
        }),
      );
      if (planned.chequeNumber) {
        ops.push(
          tp.activityLog.create({
            data: {
              type: "CHEQUE_RECEIVED",
              message: `Cheque ${planned.chequeNumber} received (£${Number(planned.amount).toFixed(2)}) for ${visitLabelFrom(customer.name, anchor.property.addressLine)}`,
              actorId: opts.actorProfileId ?? null,
              actorRole: opts.actorRole ?? null,
            },
          }),
        );
      }
    }
    for (const v of done) {
      const plan = await planUpdate(v, now);
      if (plan) ops.push(plan.op);
    }
    if (anchor && opts.note) {
      ops.push(tp.propertyNote.create({ data: { propertyId: anchor.propertyId, body: opts.note, type: "INTERNAL" } }));
    }
    for (const v of done) {
      ops.push(tp.integrationOutbox.create({ data: { eventType: "visit.completed", payload: { customerId, visitId: v.id } } }));
    }
    if (anchor && queueDdSetupLink) {
      ops.push(tp.integrationOutbox.create({ data: { eventType: DD_SETUP_LINK_EVENT, payload: { customerId, visitId: anchor.id } } }));
    }
    if (anchor && !customer.messagesOptOut) {
      ops.push(
        tp.integrationOutbox.create({
          data: {
            eventType: VISIT_COMPLETED_MESSAGE_EVENT,
            payload: { customerId, visitId: anchor.id, visitIds: done.map((v) => v.id), template: VISIT_COMPLETED_TEMPLATE_NAME },
          },
        }),
      );
    }
    if (anchor && chosen) {
      ops.push(
        tp.activityLog.create({
          data: {
            type: "PAYMENT_METHOD_RECORDED",
            message: `Technician recorded ${chosen} for visit ${visitLabelFrom(customer.name, anchor.property.addressLine)}`,
            actorId: opts.actorProfileId ?? null,
            actorRole: opts.actorRole ?? null,
          },
        }),
      );
      if (input?.updateCustomerDefault) {
        ops.push(tp.customer.update({ where: { id: customerId }, data: { paymentMethod: chosen } }));
      }
    }

    let results: unknown[];
    try {
      results = await tp.$transaction(ops);
    } catch (err) {
      // BUG-005: a double tap / retry completes the stop twice at once; the loser hits the unique Payment.visitId.
      if (anchor && (err as { code?: string }).code === "P2002") {
        const won = await tp.visit.findUnique({ where: { id: anchor.id }, select: { id: true, status: true } });
        if (won?.status === VisitStatus.COMPLETED) return { id: won.id, status: won.status, payment: null, invoice: null };
      }
      throw err;
    }

    if (skipped.length) {
      // NOTIF-03: the office sees which services were left and why, once per stop. Best effort.
      try {
        await notifyAdmins(tp, {
          type: "SCHEDULE",
          title: "Services skipped",
          body: skipped.map((v) => `${v.service?.name ?? DEFAULT_SERVICE_NAME}: ${listed.get(v.id)!.skipReason}`).join("; "),
          data: {
            visitId: stop[0].id,
            propertyId: visit.propertyId,
            ...(visit.roundId ? { roundId: visit.roundId } : {}),
            date: visit.date.toISOString().slice(0, 10),
          },
        });
      } catch (err) {
        console.error(`[visit-completion] skip notification failed for visit ${visitId}:`, err);
      }
    }

    const payment = paymentIndex >= 0 ? (results[paymentIndex] as { id: string; method: PaymentMethod; status: PaymentStatus; amount: Prisma.Decimal | number }) : null;
    let invoice: CompleteVisitResult["invoice"] = null;
    if (anchor) {
      try {
        const created = await createInvoiceService(tp).autoCreateForCompletedVisit(anchor.id);
        invoice = created ? { id: created.invoiceId, status: created.status } : null;
      } catch (err) {
        console.error(`[visit-completion] auto-invoice failed for visit ${anchor.id}:`, err);
      }
    }

    return {
      id: anchor?.id ?? visitId,
      status: stopStatus(stop.map(after)),
      payment: payment ? { id: payment.id, method: payment.method, status: payment.status, amount: Number(payment.amount) } : null,
      invoice,
      ...(queueDdSetupLink ? { directDebitSetupLinkQueued: true } : {}),
      services: servicesAfter(),
      ignored,
    };
  }

  return {
    async completeVisit(visitId: string, opts: CompleteVisitOptions = {}): Promise<CompleteVisitResult> {
      if (opts.services) return completeStop(visitId, { ...opts, services: opts.services });
      const visit = await tp.visit.findUnique({
        where: { id: visitId },
        include: { property: { include: { customer: true } }, servicePlan: true, payment: true },
      });
      if (!visit) throw new AppError(404, "Visit not found");
      if (visit.status === VisitStatus.COMPLETED) return { id: visit.id, status: visit.status, payment: null, invoice: null };
      if (visit.status === VisitStatus.SKIPPED) throw new AppError(409, "Cannot complete a skipped visit");
      if (visit.status === VisitStatus.CANCELLED) throw new AppError(409, "Cannot complete a cancelled visit");

      const customer = visit.property.customer;
      const customerId = customer.id;
      // Effective method: visit override → service plan → customer default (D-9).
      const input = opts.payment;
      // Wave 2B-2: the technician's choice (method, or collectVia when method is NONE) is the method of record.
      const chosen = (input && input.method !== "NONE" ? input.method : input?.collectVia) as PaymentMethod | undefined;
      const offSite = chosen === PaymentMethod.BACS || chosen === PaymentMethod.GOCARDLESS || chosen === PaymentMethod.STRIPE;
      const effectiveMethod =
        (offSite
          ? chosen
          : (visit.paymentMethod ?? visit.servicePlan?.paymentMethod ?? customer.paymentMethod)) as PaymentMethod | null;
      // A3: money is taken at the VAT-inclusive total (the invoice amount).
      const settings = await getCachedBusinessSettings(tp);
      const gross = grossOf(visit.price.toNumber(), settings);
      // Direct Debit with no mandate in place: nothing can be collected, so the customer is sent a setup link instead.
      const queueDdSetupLink =
        effectiveMethod === PaymentMethod.GOCARDLESS &&
        !!settings?.gocardlessConnected &&
        !(customer.gocardlessMandateStatus && MANDATE_IN_PLACE.has(customer.gocardlessMandateStatus));

      // ---- 1. Decide the payment (validation only, no writes) -------------
      let planned: PlannedPayment | null = null;
      if (!visit.payment) {
        if (input?.method === "CASH") {
          planned = { method: PaymentMethod.CASH, status: PaymentStatus.PAID, amount: input.amount ?? gross };
        } else if (input?.method === "CHEQUE") {
          planned = {
            method: PaymentMethod.CHEQUE,
            status: PaymentStatus.PENDING,
            amount: input.amount ?? gross,
            chequeNumber: input.chequeNumber,
          };
        } else if (effectiveMethod === PaymentMethod.CASH) {
          throw new AppError(
            400,
            'Cash payment must be confirmed: send payment { method: "CASH" } (or cashConfirmed: true)',
            "PAYMENT_CONFIRMATION_REQUIRED",
          );
        } else if (effectiveMethod === PaymentMethod.BACS || effectiveMethod === PaymentMethod.CHEQUE) {
          planned = { method: effectiveMethod, status: PaymentStatus.PENDING, amount: gross };
        } else if (
          effectiveMethod === PaymentMethod.GOCARDLESS &&
          customer.gocardlessMandateId &&
          customer.gocardlessMandateStatus === "active"
        ) {
          // ---- 2. External charge before any DB write ---------------------
          const gocardlessId = await chargeGoCardless(tp, {
            mandateId: customer.gocardlessMandateId,
            amount: gross,
            description: `Window cleaning — visit ${visit.id}`,
            visitId: visit.id,
            customerId,
          });
          if (gocardlessId) {
            planned = { method: PaymentMethod.GOCARDLESS, status: PaymentStatus.PENDING, amount: gross, gocardlessId };
          }
        }
      }

      // ---- 3. One transaction for every write -----------------------------
      const now = new Date();
      const ops: Prisma.PrismaPromise<unknown>[] = [
        tp.visit.update({
          where: { id: visit.id },
          data: { status: VisitStatus.COMPLETED, completedAt: now, ...(chosen ? { collectedVia: chosen } : {}) },
        }),
      ];
      if (planned) {
        ops.push(
          tp.payment.create({
            data: {
              customerId,
              visitId: visit.id,
              amount: planned.amount,
              method: planned.method,
              status: planned.status,
              ...(planned.status === PaymentStatus.PAID ? { paidAt: now } : {}),
              ...(planned.gocardlessId ? { gocardlessId: planned.gocardlessId } : {}),
              ...(planned.chequeNumber ? { reference: planned.chequeNumber } : {}),
            },
          }),
        );
        if (planned.chequeNumber) {
          // The cheque number is stored on Payment.reference; the activity log
          // entry keeps the receipt visible in the admin audit trail too.
          ops.push(
            tp.activityLog.create({
              data: {
                type: "CHEQUE_RECEIVED",
                message: `Cheque ${planned.chequeNumber} received (£${Number(planned.amount).toFixed(2)}) for ${visitLabelFrom(customer.name, visit.property.addressLine)}`,
                actorId: opts.actorProfileId ?? null,
                actorRole: opts.actorRole ?? null,
              },
            }),
          );
        }
      }
      // A6: the plan's "last completed" date (shown as Last clean in the app).
      // GEN-001 / VIS-004n: a one-off visit (no servicePlanId) completes the property's ACTIVE plan when that plan is due.
      // The plan moves one cycle ahead only if its nextDueDate is not already in the future (the nightly job advances it
      // when it creates a visit, so a generated visit never double-advances it).
      const plan = await planUpdate(visit, now);
      if (plan) ops.push(plan.op);
      if (opts.note) {
        ops.push(tp.propertyNote.create({ data: { propertyId: visit.propertyId, body: opts.note, type: "INTERNAL" } }));
      }
      // Same visit.completed GHL event the admin route has always queued (D-9),
      // plus the "Visit completed" customer message (A5) — written in the same
      // transaction so the events exist iff the completion does. Customers who
      // opted out of automated messages get no "Visit completed" message.
      ops.push(
        tp.integrationOutbox.create({ data: { eventType: "visit.completed", payload: { customerId, visitId: visit.id } } }),
      );
      if (queueDdSetupLink) {
        ops.push(tp.integrationOutbox.create({ data: { eventType: DD_SETUP_LINK_EVENT, payload: { customerId, visitId: visit.id } } }));
      }
      if (!customer.messagesOptOut) {
        ops.push(
          tp.integrationOutbox.create({
            data: {
              eventType: VISIT_COMPLETED_MESSAGE_EVENT,
              payload: { customerId, visitId: visit.id, template: VISIT_COMPLETED_TEMPLATE_NAME },
            },
          }),
        );
      }

      // Wave 2B-2: audit the technician's chosen method and optionally update the customer's usual one.
      // Appended after the payment op so results[1] is still the payment.
      if (chosen) {
        ops.push(
          tp.activityLog.create({
            data: {
              type: "PAYMENT_METHOD_RECORDED",
              message: `Technician recorded ${chosen} for visit ${visitLabelFrom(customer.name, visit.property.addressLine)}`,
              actorId: opts.actorProfileId ?? null,
              actorRole: opts.actorRole ?? null,
            },
          }),
        );
        if (input?.updateCustomerDefault) {
          ops.push(tp.customer.update({ where: { id: customerId }, data: { paymentMethod: chosen } }));
        }
      }

      let results: unknown[];
      try {
        results = await tp.$transaction(ops);
      } catch (err) {
        // BUG-005: a double tap / retry on a flaky network completes the same visit twice at once. The loser hits the
        // unique Payment.visitId; if the visit is completed by now, the winner's result is the answer.
        if ((err as { code?: string }).code === "P2002") {
          const now = await tp.visit.findUnique({ where: { id: visit.id }, select: { id: true, status: true } });
          if (now?.status === VisitStatus.COMPLETED) return { id: now.id, status: now.status, payment: null, invoice: null };
        }
        throw err;
      }
      const updated = results[0] as { id: string; status: VisitStatus };
      const payment = planned
        ? (results[1] as { id: string; method: PaymentMethod; status: PaymentStatus; amount: Prisma.Decimal })
        : null;

      // A1: invoice on completion, after the completion has committed so a
      // billing problem can never undo or block the technician's work. The
      // payment (A2: PAID cash -> PAID invoice) is already stored at this point.
      let invoice: CompleteVisitResult["invoice"] = null;
      try {
        const created = await createInvoiceService(tp).autoCreateForCompletedVisit(visit.id);
        invoice = created ? { id: created.invoiceId, status: created.status } : null;
      } catch (err) {
        console.error(`[visit-completion] auto-invoice failed for visit ${visit.id}:`, err);
      }

      return {
        id: updated.id,
        status: updated.status,
        payment: payment
          ? { id: payment.id, method: payment.method, status: payment.status, amount: Number(payment.amount) }
          : null,
        invoice,
        ...(queueDdSetupLink ? { directDebitSetupLinkQueued: true } : {}),
      };
    },
  };
}
