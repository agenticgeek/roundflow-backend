import { PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { TEMPLATE_NAMES } from "./message-templates";

// Shared visit completion used by PATCH /visits/:id/complete (web) and
// PATCH /mobile/visits/:id/complete (technician app).
//
// D-2: all payment input is validated, and any GoCardless charge is created,
// BEFORE anything is written. The visit status, Payment row, cheque log and
// outbox events are then written in ONE transaction, so a 400 leaves the visit
// untouched and a retry works.

export type CompletionPaymentMethod = "CASH" | "CHEQUE" | "NONE";

export interface CompletionPaymentInput {
  method: CompletionPaymentMethod;
  amount?: number;
  chequeNumber?: string;
}

export interface CompleteVisitOptions {
  payment?: CompletionPaymentInput;
  note?: string;
  actorProfileId?: string;
  actorRole?: string;
}

export interface CompleteVisitResult {
  id: string;
  status: VisitStatus;
  payment: { id: string; method: PaymentMethod; status: PaymentStatus; amount: number } | null;
}

// Outbox event for the "Visit completed" customer message (A5). The outbox
// worker (src/jobs/outboxWorker.ts) renders the tenant's "Visit completed"
// MessageTemplate (built-in fallback body when absent) and sends it via GHL.
export const VISIT_COMPLETED_MESSAGE_EVENT = "message.visit_completed";
export const VISIT_COMPLETED_TEMPLATE_NAME = TEMPLATE_NAMES.VISIT_COMPLETED;

const METHODS: readonly CompletionPaymentMethod[] = ["CASH", "CHEQUE", "NONE"];
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

  return { method, amount, chequeNumber };
}

type PlannedPayment = {
  method: PaymentMethod;
  status: PaymentStatus;
  amount: Prisma.Decimal | number;
  gocardlessId?: string;
  chequeNumber?: string;
};

export function createVisitCompletionService(tp: TenantPrismaClient) {
  return {
    async completeVisit(visitId: string, opts: CompleteVisitOptions = {}): Promise<CompleteVisitResult> {
      const visit = await tp.visit.findUnique({
        where: { id: visitId },
        include: { property: { include: { customer: true } }, servicePlan: true, payment: true },
      });
      if (!visit) throw new AppError(404, "Visit not found");
      if (visit.status === VisitStatus.COMPLETED) return { id: visit.id, status: visit.status, payment: null };
      if (visit.status === VisitStatus.SKIPPED) throw new AppError(409, "Cannot complete a skipped visit");
      if (visit.status === VisitStatus.CANCELLED) throw new AppError(409, "Cannot complete a cancelled visit");

      const customer = visit.property.customer;
      const customerId = customer.id;
      // Effective method: visit override → service plan → customer default (D-9).
      const effectiveMethod =
        (visit.paymentMethod ?? visit.servicePlan?.paymentMethod ?? customer.paymentMethod) as PaymentMethod | null;
      const input = opts.payment;

      // ---- 1. Decide the payment (validation only, no writes) -------------
      let planned: PlannedPayment | null = null;
      if (!visit.payment) {
        if (input?.method === "CASH") {
          planned = { method: PaymentMethod.CASH, status: PaymentStatus.PAID, amount: input.amount ?? visit.price };
        } else if (input?.method === "CHEQUE") {
          planned = {
            method: PaymentMethod.CHEQUE,
            status: PaymentStatus.PENDING,
            amount: input.amount ?? visit.price,
            chequeNumber: input.chequeNumber,
          };
        } else if (effectiveMethod === PaymentMethod.CASH) {
          throw new AppError(
            400,
            'Cash payment must be confirmed: send payment { method: "CASH" } (or cashConfirmed: true)',
            "PAYMENT_CONFIRMATION_REQUIRED",
          );
        } else if (effectiveMethod === PaymentMethod.BACS || effectiveMethod === PaymentMethod.CHEQUE) {
          planned = { method: effectiveMethod, status: PaymentStatus.PENDING, amount: visit.price };
        } else if (
          effectiveMethod === PaymentMethod.GOCARDLESS &&
          customer.gocardlessMandateId &&
          customer.gocardlessMandateStatus === "active"
        ) {
          // ---- 2. External charge before any DB write ---------------------
          const bs = await tp.businessSettings.findFirst({
            select: { gocardlessAccessTokenEncrypted: true, gocardlessEnvironment: true },
          });
          if (bs?.gocardlessAccessTokenEncrypted) {
            const { decrypt } = await import("../lib/crypto.js");
            const { getGcClient } = await import("../integrations/gocardless/client.js");
            const { createGcPayment } = await import("../integrations/gocardless/payment.js");
            const client = getGcClient(decrypt(bs.gocardlessAccessTokenEncrypted), bs.gocardlessEnvironment ?? "sandbox");
            const gcPayment = await createGcPayment(client, {
              mandateId: customer.gocardlessMandateId,
              amountPence: Math.round(visit.price.toNumber() * 100),
              description: `Window cleaning — visit ${visit.id}`,
              reference: visit.id.slice(-8).toUpperCase(),
              metadata: { visitId: visit.id, customerId },
            });
            planned = { method: PaymentMethod.GOCARDLESS, status: PaymentStatus.PENDING, amount: visit.price, gocardlessId: gcPayment.id };
          }
        }
      }

      // ---- 3. One transaction for every write -----------------------------
      const now = new Date();
      const ops: Prisma.PrismaPromise<unknown>[] = [
        tp.visit.update({ where: { id: visit.id }, data: { status: VisitStatus.COMPLETED, completedAt: now } }),
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
                message: `Cheque ${planned.chequeNumber} received for visit ${visit.id} (£${Number(planned.amount).toFixed(2)}) — ${customer.name}`,
                actorId: opts.actorProfileId ?? null,
                actorRole: opts.actorRole ?? null,
              },
            }),
          );
        }
      }
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

      const results = await tp.$transaction(ops);
      const updated = results[0] as { id: string; status: VisitStatus };
      const payment = planned
        ? (results[1] as { id: string; method: PaymentMethod; status: PaymentStatus; amount: Prisma.Decimal })
        : null;

      return {
        id: updated.id,
        status: updated.status,
        payment: payment
          ? { id: payment.id, method: payment.method, status: payment.status, amount: Number(payment.amount) }
          : null,
      };
    },
  };
}
