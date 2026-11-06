import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optString, optBool } from "../lib/http";
import { createTodayService } from "../services/today.service";
import { createReportsService } from "../services/reports.service";

export const todayRouter = Router();
todayRouter.use(requireAuth);
todayRouter.use(requireTenantAccess);
todayRouter.use(requireBusinessAccess());

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
    res.json(await svc(req).getTodaysWork());
  })
);

// ==========================================================================
// POST /today/close — Close Operational Day (M21).
//   Body: { unfinishedAction: "push_to_tomorrow" | "mark_as_skipped", skipReason?: string, target?: "NEXT_WORKING_DAY" | "SATURDAY" | "MONDAY" }
//   target picks the carryover day for push_to_tomorrow (default: the option flagged default; Friday offers Saturday/Monday).
//   notifyCustomers (default false, push_to_tomorrow only): also message the carried visits' customers (best effort;
//   the result carries notifiedCustomers and customerNotificationError).
//   skipReason (max 255, mark_as_skipped only) is stored on every visit skipped by the close;
//   default "Not completed - day closed".
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
    const skipReason = optString(body.skipReason, "skipReason", { maxLength: 255 });
    const target = optString(body.target, "target", { maxLength: 32 }) ?? undefined;
    const notifyCustomers = optBool(body.notifyCustomers, "notifyCustomers") === true;
    const result = await svc(req).closeDay(raw, skipReason, target, {
      id: req.profile?.id,
      role: req.profile?.role ?? undefined,
    }, { notifyCustomers });
    void createReportsService(req.tenantPrisma!).logActivity(
      "DAY_CLOSED",
      `Operational day closed (unfinished: ${raw})`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);
