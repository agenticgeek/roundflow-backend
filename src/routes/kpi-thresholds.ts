import { Request, Router } from "express";
import { KpiOperator } from "../generated/tenant-client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asArray, h } from "../lib/http";
import {
  createKpiThresholdService,
  KPI_METRICS,
  type KpiMetric,
  type ThresholdInput,
} from "../services/kpi-threshold.service";

// Mounted at /settings/kpi-thresholds (B6 · GAP-025). ADMIN/MANAGER only.
export const kpiThresholdsRouter = Router();
kpiThresholdsRouter.use(requireAuth);
kpiThresholdsRouter.use(requireTenantAccess);
kpiThresholdsRouter.use(requireBusinessAccess());

const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createKpiThresholdService(req.tenantPrisma);
};

const OPERATORS = Object.values(KpiOperator) as string[];

function parseThreshold(raw: unknown, index: number): ThresholdInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, `thresholds[${index}] must be an object`);
  }
  const { metric, operator, value } = raw as Record<string, unknown>;
  if (typeof metric !== "string" || !(KPI_METRICS as readonly string[]).includes(metric)) {
    throw new AppError(400, `thresholds[${index}].metric must be one of: ${KPI_METRICS.join(", ")}`);
  }
  if (typeof operator !== "string" || !OPERATORS.includes(operator)) {
    throw new AppError(400, `thresholds[${index}].operator must be one of: ${OPERATORS.join(", ")}`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 99_999_999) {
    throw new AppError(400, `thresholds[${index}].value must be a number between 0 and 99999999`);
  }
  return { metric: metric as KpiMetric, operator: operator as KpiOperator, value };
}

// GET /settings/kpi-thresholds → [{ id, metric, operator, value }]
kpiThresholdsRouter.get(
  "/",
  h(async (req, res) => {
    res.json(await svc(req).list());
  })
);

// PUT /settings/kpi-thresholds — replace all. Body: raw array or { thresholds: [...] }.
kpiThresholdsRouter.put(
  "/",
  h(async (req, res) => {
    const items = asArray<unknown>(req.body, "thresholds").map(parseThreshold);
    res.json(await svc(req).replaceAll(items));
  })
);
