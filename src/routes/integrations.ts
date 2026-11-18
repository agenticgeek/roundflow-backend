import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { enforceAdminOnlyRoutes } from "../middleware/requireAdmin";
import { AppError } from "../lib/app-error";
import { asObject, h, parsePageParams, requireString } from "../lib/http";
import { createDirectDebitService } from "../services/direct-debit.service";

// BE-12: dead-letter view and replay for the integration outbox (GHL sends, invoice.send). ADMIN only
// (src/lib/permissions.ts): rows reference customers and can re-send customer messages.
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);
integrationsRouter.use(requireTenantAccess);
integrationsRouter.use(requireBusinessAccess());
integrationsRouter.use(enforceAdminOnlyRoutes());

const LISTABLE = ["dead", "failed"] as const;
type Listable = (typeof LISTABLE)[number];

// GET /integrations/outbox?status=dead|failed&page&pageSize
// -> { rows: [{ id, eventType, status, attempts, lastError, customerId, batchId, createdAt, processedAt }], pagination }
integrationsRouter.get(
  "/outbox",
  h(async (req, res) => {
    const status = (req.query.status ?? "dead") as string;
    if (!(LISTABLE as readonly string[]).includes(status)) throw new AppError(400, "status must be dead or failed", "INVALID_STATUS");
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, { defaultPageSize: 50, maxPageSize: 100 });

    const where = { status: status as Listable };
    const tp = req.tenantPrisma!;
    const [total, rows] = await Promise.all([
      tp.integrationOutbox.count({ where }),
      tp.integrationOutbox.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
    ]);
    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        status: r.status,
        attempts: r.attempts,
        lastError: r.lastError,
        customerId: (r.payload as { customerId?: string } | null)?.customerId ?? null,
        batchId: r.batchId,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

// POST /integrations/outbox/:id/replay — put a dead/failed row back in the queue with a fresh attempt budget.
// 404 OUTBOX_NOT_FOUND · 409 OUTBOX_NOT_REPLAYABLE (only dead/failed rows). Drained by the next worker run (GHL-connected tenants).
integrationsRouter.post(
  "/outbox/:id/replay",
  h(async (req, res) => {
    const tp = req.tenantPrisma!;
    const row = await tp.integrationOutbox.findUnique({ where: { id: req.params.id }, select: { id: true, eventType: true, status: true } });
    if (!row) throw new AppError(404, "Outbox row not found", "OUTBOX_NOT_FOUND");

    const claimed = await tp.integrationOutbox.updateMany({
      where: { id: row.id, status: { in: [...LISTABLE] } },
      data: { status: "pending", attempts: 0, lastError: null, processedAt: null, runAfter: null },
    });
    if (claimed.count === 0) throw new AppError(409, `A ${row.status} row cannot be replayed`, "OUTBOX_NOT_REPLAYABLE");

    await tp.activityLog.create({
      data: {
        type: "OUTBOX_REPLAYED",
        message: `Integration message ${row.eventType} replayed`,
        actorId: req.profile!.id,
        actorRole: req.profile!.role,
        entityId: row.id,
      },
    });
    res.json({ id: row.id, status: "pending" });
  })
);

// GET /integrations/gocardless/mandates/import — existing GoCardless mandates with a suggested customer each (ADMIN)
integrationsRouter.get(
  "/gocardless/mandates/import",
  h(async (req, res) => {
    res.json(await createDirectDebitService(req.tenantPrisma!).importCandidates());
  })
);

// POST /integrations/gocardless/mandates/import { links: [{ mandateId, customerId }] } — link the confirmed pairs (ADMIN)
integrationsRouter.post(
  "/gocardless/mandates/import",
  h(async (req, res) => {
    const body = asObject(req.body);
    if (!Array.isArray(body.links) || body.links.length === 0 || body.links.length > 500) {
      throw new AppError(400, '"links" must be an array of 1 to 500 { mandateId, customerId } pairs.');
    }
    const links = body.links.map((raw, i) => {
      const item = asObject(raw);
      return { mandateId: requireString(item.mandateId, `links[${i}].mandateId`), customerId: requireString(item.customerId, `links[${i}].customerId`) };
    });
    res.json(await createDirectDebitService(req.tenantPrisma!, { id: req.profile?.id, role: req.profile?.role }).importMandates(links));
  })
);
