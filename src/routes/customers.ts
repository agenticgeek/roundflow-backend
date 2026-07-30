import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import {
  asObject,
  h,
  requireString,
  requireNumber,
  optString,
  optReqString,
  optReqNumber,
  optId,
} from "../lib/http";
import { assertPositive, optPaymentMethod, optPropertyType, optIsoDate } from "../lib/validation";
import {
  createCustomerService,
  CustomerCreateInput,
  CustomerUpdateInput,
  PropertyAddInput,
} from "../services/customer.service";

export const customersRouter = Router();
customersRouter.use(requireAuth);
customersRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
customersRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createCustomerService(req.tenantPrisma);
};

// Thin routes: validate → call service → respond. No DB access here.
// Returns the Supabase user ID of the acting caller (the profileId seam).
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

// ==========================================================================
// POST /customers — create a standalone customer (no property yet)
// ==========================================================================
customersRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: CustomerCreateInput = {
      name: requireString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      email: optString(body.email, "email"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
    };
    res.status(201).json(await svc(req).createCustomer(actorIdOf(req), input));
  })
);

// ==========================================================================
// GET /customers — list + summary KPIs (Screen 14)
// ==========================================================================
customersRouter.get(
  "/",
  h(async (req, res) => {
    const VALID_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED", "HOLD"];
    const rawStatus = req.query.status;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== "string") {
        throw new AppError(400, "status must be a single query parameter");
      }
      if (!VALID_STATUSES.includes(rawStatus)) {
        throw new AppError(400, `status must be one of: ${VALID_STATUSES.join(", ")}`);
      }
    }
    const pageRaw = Number(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);
    res.json(
      await svc(req).getCustomers(
        actorIdOf(req),
        {
          search: (() => {
            const s = typeof req.query.search === "string" ? req.query.search : undefined;
            if (s !== undefined && s.includes("\0")) throw new AppError(400, "search must not contain null bytes");
            return s;
          })(),
          roundId: typeof req.query.roundId === "string" ? req.query.roundId : undefined,
          status: rawStatus as string | undefined,
          page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : undefined,
          pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined,
        },
        req.profile!.role
      )
    );
  })
);

// ==========================================================================
// GET /customers/:id — full Customer Detail aggregate (Screen 15, all 6 tabs)
// ==========================================================================
customersRouter.get(
  "/:id",
  h(async (req, res) => {
    res.json(await svc(req).getCustomerDetail(actorIdOf(req), req.params.id, req.profile!.role));
  })
);

// ==========================================================================
// PATCH /customers/:id — M19 Edit Customer Record (Customer + Property + Plan)
// ==========================================================================
customersRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const price = optReqNumber(body.price, "price");
    if (price !== undefined) assertPositive(price, "price");

    const input: CustomerUpdateInput = {
      // Customer (name is required-non-null → optReqString rejects null/blank)
      name: optReqString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      email: optString(body.email, "email"),
      // Property
      addressLine: optReqString(body.addressLine, "addressLine"),
      postcode: optReqString(body.postcode, "postcode"),
      propertyType: optPropertyType(body.propertyType),
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      roundId: optId(body.roundId, "roundId"), // null = unassign (OQ-CP4)
      // ServicePlan (Assigned Technician is deferred to M3 — per-Visit)
      price,
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
    };
    res.json(await svc(req).updateCustomer(actorIdOf(req), req.params.id, input));
  })
);

// ==========================================================================
// DELETE /customers/:id — soft-delete customer (CANCELLED + cascades)
// ==========================================================================
customersRouter.delete(
  "/:id",
  h(async (req, res) => {
    await svc(req).deleteCustomer(actorIdOf(req), req.params.id);
    res.status(204).send();
  })
);

// ==========================================================================
// POST /customers/:id/properties — add a property to an existing customer
// ==========================================================================
customersRouter.post(
  "/:id/properties",
  h(async (req, res) => {
    const body = asObject(req.body);
    const price = requireNumber(body.price, "price");
    assertPositive(price, "price");
    const input: PropertyAddInput = {
      addressLine: requireString(body.addressLine, "addressLine").trim(),
      postcode: requireString(body.postcode, "postcode").trim(),
      propertyName: optString(body.propertyName, "propertyName"),
      propertyType: optPropertyType(body.propertyType),
      serviceAreaId: requireString(body.serviceAreaId, "serviceAreaId"),
      serviceId: optId(body.serviceId, "serviceId"),
      price,
      cleanMethod: optString(body.cleanMethod, "cleanMethod"),
      paymentMethod: optPaymentMethod(body.paymentMethod),
      nextDueDate: optIsoDate(body.nextDueDate, "nextDueDate"),
      accessNotes: optString(body.accessNotes, "accessNotes"),
      riskNotes: optString(body.riskNotes, "riskNotes"),
      roundId: optId(body.roundId, "roundId"),
    };
    res.status(201).json(await svc(req).addPropertyToCustomer(actorIdOf(req), req.params.id, input));
  })
);
