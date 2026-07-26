import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optReqString, optString, optId } from "../lib/http";
import {
  requireCleaningFrequency,
  optCleaningFrequency,
  optDayOfWeek,
  optRoundStatus,
  optIsoDate,
} from "../lib/validation";
import { createRoundService, RoundCreateInput, RoundUpdateInput } from "../services/round.service";

export const roundsRouter = Router();
roundsRouter.use(requireAuth);
roundsRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
roundsRouter.use(requireBusinessAccess());

// Thin routes: validate → call service → respond. No DB access here.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;
const svc = (req: Request) => createRoundService(req.tenantPrisma!);

// ==========================================================================
// GET /rounds — list rounds; ?status=ACTIVE|DRAFT|ARCHIVED (optional filter)
// ==========================================================================
roundsRouter.get(
  "/",
  h(async (req, res) => {
    const status = optRoundStatus(req.query.status);
    res.json(await svc(req).listRounds(actorIdOf(req), status));
  })
);

// ==========================================================================
// POST /rounds — create a round (always ACTIVE; frequency + serviceAreaId required)
// ==========================================================================
roundsRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: RoundCreateInput = {
      name: requireString(body.name, "name"),
      frequency: requireCleaningFrequency(body.frequency),
      serviceAreaId: requireString(body.serviceAreaId, "serviceAreaId"),
      defaultDay: optDayOfWeek(body.defaultDay),
      description: optString(body.description, "description"),
    };
    res.status(201).json(await svc(req).createRound(actorIdOf(req), input));
  })
);

// ==========================================================================
// GET /rounds/:id — round detail with technicians and property count
// ==========================================================================
roundsRouter.get(
  "/:id",
  h(async (req, res) => {
    res.json(await svc(req).getRound(actorIdOf(req), req.params.id));
  })
);

// ==========================================================================
// PATCH /rounds/:id — partial update (name, frequency, serviceAreaId, defaultDay, description, status)
// ==========================================================================
roundsRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);
    const input: RoundUpdateInput = {
      name: optReqString(body.name, "name"),
      frequency: optCleaningFrequency(body.frequency),
      serviceAreaId: optId(body.serviceAreaId, "serviceAreaId"),
      defaultDay: optDayOfWeek(body.defaultDay),
      description: optString(body.description, "description"),
      status: optRoundStatus(body.status),
    };
    res.json(await svc(req).updateRound(actorIdOf(req), req.params.id, input));
  })
);

// ==========================================================================
// GET /rounds/:id/planner/occurrences — calendar view: occurrence dates with
//   aggregate stats. Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD date filter.
// ==========================================================================
roundsRouter.get(
  "/:id/planner/occurrences",
  h(async (req, res) => {
    const from = optIsoDate(req.query.from, "from") ?? undefined;
    const to = optIsoDate(req.query.to, "to") ?? undefined;
    res.json(await svc(req).listOccurrences(actorIdOf(req), req.params.id, from, to));
  })
);

// ==========================================================================
// GET /rounds/:id/planner/occurrences/:date — list/map view: all stops for a
//   specific occurrence date (YYYY-MM-DD), with per-stop detail + summary.
// ==========================================================================
roundsRouter.get(
  "/:id/planner/occurrences/:date",
  h(async (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new AppError(400, '"date" must be a valid YYYY-MM-DD date');
    }
    res.json(await svc(req).getOccurrence(actorIdOf(req), req.params.id, date));
  })
);

// ==========================================================================
// PUT /rounds/:id/technicians — replace technician list (empty array = clear all)
// ==========================================================================
roundsRouter.put(
  "/:id/technicians",
  h(async (req, res) => {
    const body = asObject(req.body);
    if (
      !Array.isArray(body.technicianIds) ||
      !(body.technicianIds as unknown[]).every((x) => typeof x === "string")
    ) {
      throw new AppError(400, '"technicianIds" must be an array of strings.');
    }
    res.json(
      await svc(req).setTechnicians(actorIdOf(req), req.params.id, body.technicianIds as string[])
    );
  })
);
