import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { runWithClock } from "../lib/clock";
import { h } from "../lib/http";
import { generateForTenant } from "../jobs/visitGeneration";
import { tenantToday } from "../services/business-time";

// Test hooks (business closures). Bootstrap mounts this ONLY when
// testClockEnabled(); otherwise /test-hooks does not exist (404).
export function createTestHooksRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireTenantAccess);
  router.use(requireRole(UserRole.ADMIN));

  // POST /test-hooks/run-nightly { at?: ISO } -> { date: "YYYY-MM-DD" }
  // Runs the nightly generation for the CALLING tenant only.
  router.post(
    "/run-nightly",
    h(async (req: Request, res) => {
      const tp = req.tenantPrisma;
      if (!tp) throw new AppError(500, "Tenant client not initialised");
      const rawAt = (req.body as { at?: unknown } | undefined)?.at;
      let at: Date | undefined;
      if (rawAt !== undefined) {
        at = typeof rawAt === "string" ? new Date(rawAt) : new Date(NaN);
        if (Number.isNaN(at.getTime())) throw new AppError(400, '"at" must be an ISO 8601 instant', "INVALID_TEST_NOW");
      }
      const run = async () => {
        const today = await tenantToday(tp);
        await generateForTenant(tp, today);
        return today;
      };
      const today = await (at ? runWithClock(at, run) : run());
      res.json({ date: today.toISOString().slice(0, 10) });
    })
  );
  return router;
}
