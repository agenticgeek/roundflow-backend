import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, requireNumber, optString, optId, optBool } from "../lib/http";
import { assertPositive, optPaymentMethod } from "../lib/validation";
import { createVisitService, VisitCreateInput } from "../services/visit.service";
import { createReportsService } from "../services/reports.service";
import { PaymentMethod, PaymentStatus, VisitStatus } from "../generated/tenant-client";
import { queueGhlEvent } from "../integrations/ghl/sync";

export const visitsRouter = Router();
visitsRouter.use(requireAuth);
visitsRouter.use(requireTenantAccess);
visitsRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createVisitService(req.tenantPrisma);
};

// ==========================================================================
// POST /visits — create a one-off (ad-hoc) visit
// ==========================================================================
visitsRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const price = requireNumber(body.price, "price");
    assertPositive(price, "price", 9999.99);

    const input: VisitCreateInput = {
      propertyId: requireString(body.propertyId, "propertyId"),
      date: requireString(body.date, "date"),
      price,
      serviceId: optId(body.serviceId, "serviceId"),
      technicianId: optId(body.technicianId, "technicianId"),
      roundId: optId(body.roundId, "roundId"),
      notes: optString(body.notes, "notes"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
    };

    const result = await svc(req).createVisit(input);

    void createReportsService(req.tenantPrisma!).logActivity(
      "ONE_OFF_JOB_ADDED",
      `One-off job added: ${input.date} — ${result.addressLine}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );

    res.status(201).json(result);
  })
);

// PATCH /visits/:id/complete
// Marks a visit COMPLETED and creates a Payment record based on payment method.
// For GOCARDLESS: auto-charges against the customer's active mandate.
// For CASH: requires cashConfirmed=true (technician confirmed receipt on mobile).
// For BACS/CHEQUE: creates a PENDING payment for offline collection.
visitsRouter.patch(
  "/:id/complete",
  h(async (req, res) => {
    const body = asObject(req.body);
    const cashConfirmed = optBool(body.cashConfirmed, "cashConfirmed") ?? false;

    const visit = await req.tenantPrisma!.visit.findUnique({
      where: { id: req.params.id },
      include: {
        property: {
          include: {
            customer: true,
          },
        },
        servicePlan: true,
        payment: true,
      },
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.status === VisitStatus.COMPLETED) {
      return res.json({ id: visit.id, status: visit.status });
    }
    if (visit.status === VisitStatus.SKIPPED) {
      throw new AppError(409, "Cannot complete a skipped visit");
    }

    const effectiveMethod =
      (visit.paymentMethod ?? visit.servicePlan?.paymentMethod ?? visit.property.customer.paymentMethod) as PaymentMethod | null;

    // Update visit status
    const updated = await req.tenantPrisma!.visit.update({
      where: { id: visit.id },
      data: { status: VisitStatus.COMPLETED, completedAt: new Date() },
    });

    const customerId = visit.property.customer.id;
    const amountPence = Math.round(visit.price.toNumber() * 100);

    // Create Payment record (skip if one already exists for this visit)
    if (!visit.payment) {
      if (effectiveMethod === PaymentMethod.GOCARDLESS) {
        const customer = visit.property.customer;
        if (customer.gocardlessMandateId && customer.gocardlessMandateStatus === "active") {
          const bs = await req.tenantPrisma!.businessSettings.findFirst({
            select: { gocardlessAccessTokenEncrypted: true, gocardlessEnvironment: true },
          });
          if (bs?.gocardlessAccessTokenEncrypted) {
            const { decrypt } = await import("../lib/crypto.js");
            const { getGcClient } = await import("../integrations/gocardless/client.js");
            const { createGcPayment } = await import("../integrations/gocardless/payment.js");

            const client = getGcClient(decrypt(bs.gocardlessAccessTokenEncrypted), bs.gocardlessEnvironment ?? "sandbox");
            const gcPayment = await createGcPayment(client, {
              mandateId: customer.gocardlessMandateId,
              amountPence,
              description: `Window cleaning — visit ${visit.id}`,
              reference: visit.id.slice(-8).toUpperCase(),
              metadata: { visitId: visit.id, customerId },
            });

            await req.tenantPrisma!.payment.create({
              data: {
                customerId,
                visitId: visit.id,
                amount: visit.price,
                method: PaymentMethod.GOCARDLESS,
                status: PaymentStatus.PENDING,
                gocardlessId: gcPayment.id,
              },
            });
          }
        }
      } else if (effectiveMethod === PaymentMethod.CASH) {
        if (!cashConfirmed) throw new AppError(400, "cashConfirmed is required for cash payments");
        await req.tenantPrisma!.payment.create({
          data: {
            customerId,
            visitId: visit.id,
            amount: visit.price,
            method: PaymentMethod.CASH,
            status: PaymentStatus.PAID,
            paidAt: new Date(),
          },
        });
      } else if (
        effectiveMethod === PaymentMethod.BACS ||
        effectiveMethod === PaymentMethod.CHEQUE
      ) {
        await req.tenantPrisma!.payment.create({
          data: {
            customerId,
            visitId: visit.id,
            amount: visit.price,
            method: effectiveMethod,
            status: PaymentStatus.PENDING,
          },
        });
      }
    }

    queueGhlEvent(req.tenantPrisma!, "visit.completed", customerId).catch(console.error);

    return res.json({ id: updated.id, status: updated.status });
  })
);
