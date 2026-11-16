import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { adminIdempotency } from "../lib/idempotency";
import { h } from "../lib/http";
import { ValidationError } from "../lib/app-error";
import { createClosureService } from "../services/closure.service";
import { createClosureApplyService } from "../services/closure-apply.service";

// Mounted at /closures (business closures, 2026-11-16). Reads and writes: ADMIN or MANAGER (not TECHNICIAN).
// Writes accept the optional admin Idempotency-Key header (BE-17). Rules: closure-rules.md section 2.
export const closuresRouter = Router();
closuresRouter.use(requireAuth);
closuresRouter.use(requireTenantAccess);
closuresRouter.use(requireBusinessAccess());

const svc = (req: Request) => createClosureService(req.tenantPrisma!);

// GET /closures?from=&to= -> { closures } (default: endDate >= tenant-local today)
closuresRouter.get(
  "/",
  h(async (req, res) => {
    res.json(await svc(req).list({ from: req.query.from, to: req.query.to }));
  })
);

// POST /closures -> 201 Closure
closuresRouter.post(
  "/",
  adminIdempotency(),
  h(async (req, res) => {
    res.status(201).json(await svc(req).create(req.body, req.profile!.id));
  })
);

// PATCH /closures/:id -> Closure
closuresRouter.patch(
  "/:id",
  adminIdempotency(),
  h(async (req, res) => {
    res.json(await svc(req).update(req.params.id, req.body));
  })
);

// DELETE /closures/:id -> 204 (never restores visits already moved or skipped)
closuresRouter.delete(
  "/:id",
  adminIdempotency(),
  h(async (req, res) => {
    await svc(req).remove(req.params.id);
    res.status(204).end();
  })
);

// closures: apply routes (B6)
const applySvc = (req: Request) => createClosureApplyService(req.tenantPrisma!);

/** Body of POST /closures/:id/apply: optional `{ notifyCustomers?: boolean }`, nothing else. */
function parseApplyBody(body: unknown): { notifyCustomers?: boolean } {
  if (!body) return {};
  const fail = (path: string, message: string) => new ValidationError(message, [{ path, code: "VALIDATION_FAILED", message }]);
  if (typeof body !== "object" || Array.isArray(body)) throw fail("body", "Request body must be a JSON object.");
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => k !== "notifyCustomers");
  if (unknown.length > 0) throw fail(unknown[0], `Unknown field(s): ${unknown.join(", ")}`);
  if (raw.notifyCustomers !== undefined && typeof raw.notifyCustomers !== "boolean") {
    throw fail("notifyCustomers", `"notifyCustomers" must be a boolean.`);
  }
  return raw.notifyCustomers === undefined ? {} : { notifyCustomers: raw.notifyCustomers };
}

// POST /closures/:id/apply/preview -> 200 ClosureApplyPreview (no writes)
closuresRouter.post(
  "/:id/apply/preview",
  h(async (req, res) => {
    res.json(await applySvc(req).preview(req.params.id));
  })
);

// POST /closures/:id/apply { notifyCustomers? } -> 200 ClosureApplyResult (404 CLOSURE_NOT_FOUND, 409 CLOSURE_ENDED)
closuresRouter.post(
  "/:id/apply",
  adminIdempotency(),
  h(async (req, res) => {
    const input = parseApplyBody(req.body);
    res.json(await applySvc(req).apply(req.params.id, { ...input, actor: { id: req.profile!.id, role: req.profile!.role } }));
  })
);
// closures: end apply routes
