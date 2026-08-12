import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString } from "../lib/http";
import { createTodayService } from "../services/today.service";
import { createReportsService } from "../services/reports.service";

export const todayRouter = Router();
todayRouter.use(requireAuth);
todayRouter.use(requireTenantAccess);
todayRouter.use(requireBusinessAccess());

const actorIdOf = (req: Request): string => req.user!.supabaseUserId;
const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createTodayService(req.tenantPrisma);
};

// ==========================================================================
// GET /today — Today's Work aggregate: KPI tiles, rounds table, technician
//   workload cards (Screen 12).
// ==========================================================================
todayRouter.get(
  "/",
  h(async (req, res) => {
    res.json(await svc(req).getTodaysWork(actorIdOf(req)));
  })
);

// ==========================================================================
// POST /today/close — Close Operational Day (M21).
//   Body: { unfinishedAction: "push_to_tomorrow" | "mark_as_skipped" }
// ==========================================================================
todayRouter.post(
  "/close",
  h(async (req, res) => {
    const body = asObject(req.body);
    const raw = requireString(body.unfinishedAction, "unfinishedAction");
    if (raw !== "push_to_tomorrow" && raw !== "mark_as_skipped") {
      throw new AppError(
        400,
        '"unfinishedAction" must be "push_to_tomorrow" or "mark_as_skipped"'
      );
    }
    const result = await svc(req).closeDay(actorIdOf(req), raw);
    void createReportsService(req.tenantPrisma!).logActivity(
      "DAY_CLOSED",
      `Operational day closed (unfinished: ${raw})`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);
