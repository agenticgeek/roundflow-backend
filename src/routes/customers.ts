import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { asObject, h, optString, optReqString, optReqNumber, optId } from "../lib/http";
import { assertPositive, optPaymentMethod } from "../lib/validation";
import {
  createCustomerService,
  CustomerUpdateInput,
} from "../services/customer.service";

export const customersRouter = Router();
customersRouter.use(requireAuth);
customersRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
customersRouter.use(requireBusinessAccess());

const svc = (req: Request) => createCustomerService(req.tenantPrisma!);

// Thin routes: validate → call service → respond. No DB access here.
// Returns the Supabase user ID of the acting caller (the profileId seam).
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;

// ==========================================================================
// GET /customers — list + summary KPIs (Screen 14)
// ==========================================================================
customersRouter.get(
  "/",
  h(async (req, res) => {
    const pageRaw = Number(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);
    res.json(
      await svc(req).getCustomers(
        actorIdOf(req),
        {
          search: typeof req.query.search === "string" ? req.query.search : undefined,
          roundId: typeof req.query.roundId === "string" ? req.query.roundId : undefined,
          status: typeof req.query.status === "string" ? req.query.status : undefined,
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
      propertyType: optString(body.propertyType, "propertyType"),
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
