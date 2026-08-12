import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, requireString, optReqString, optString, optId, optBool } from "../lib/http";
import {
  requireCleaningFrequency,
  optCleaningFrequency,
  optDayOfWeek,
  optRoundStatus,
  optIsoDate,
} from "../lib/validation";
import {
  createRoundService,
  RoundCreateInput,
  RoundUpdateInput,
  ReassignInput,
  PushMissedInput,
} from "../services/round.service";
import { createReportsService } from "../services/reports.service";
import { parseIsoDate } from "../lib/validation";

export const roundsRouter = Router();
roundsRouter.use(requireAuth);
roundsRouter.use(requireTenantAccess);
// Authorization: reads allowed for any known role; mutations require ADMIN/MANAGER.
roundsRouter.use(requireBusinessAccess());

// Thin routes: validate → call service → respond. No DB access here.
const actorIdOf = (req: Request): string => req.user!.supabaseUserId;
const svc = (req: Request) => {
  if (!req.tenantPrisma) throw new AppError(500, "Tenant client not initialised");
  return createRoundService(req.tenantPrisma);
};

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
    const result = await svc(req).updateRound(actorIdOf(req), req.params.id, input);
    void createReportsService(req.tenantPrisma!).logActivity(
      "ROUND_UPDATED",
      `Round updated: ${req.params.id}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);

// ==========================================================================
// GET /rounds/:id/planner/occurrences — calendar view: occurrence dates with
//   aggregate stats. Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD date filter.
// ==========================================================================
roundsRouter.get(
  "/:id/planner/occurrences",
  h(async (req, res) => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const rawFrom = req.query.from;
    const rawTo = req.query.to;
    if (rawFrom !== undefined && (typeof rawFrom !== "string" || !dateOnly.test(rawFrom))) {
      throw new AppError(400, '"from" must be a YYYY-MM-DD date');
    }
    if (rawTo !== undefined && (typeof rawTo !== "string" || !dateOnly.test(rawTo))) {
      throw new AppError(400, '"to" must be a YYYY-MM-DD date');
    }
    // After the guards above rawFrom/rawTo are guaranteed strings (or undefined).
    const fromStr = rawFrom as string | undefined;
    const toStr = rawTo as string | undefined;
    // Visits are stored as midnight UTC timestamps; lte: midnight of 'to' is inclusive for that day.
    const from = fromStr ? new Date(`${fromStr}T00:00:00.000Z`) : undefined;
    const to = toStr ? new Date(`${toStr}T00:00:00.000Z`) : undefined;
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
    const result = await svc(req).setTechnicians(actorIdOf(req), req.params.id, body.technicianIds as string[]);
    void createReportsService(req.tenantPrisma!).logActivity(
      "TECHNICIAN_ASSIGNED",
      `Technicians assigned to round: ${req.params.id}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);

// ==========================================================================
// GET /rounds/:id/today — today's panel for a specific round (Screen 13)
// ==========================================================================
roundsRouter.get(
  "/:id/today",
  h(async (req, res) => {
    res.json(await svc(req).getTodayPanel(actorIdOf(req), req.params.id));
  })
);

// ==========================================================================
// POST /rounds/:id/reassign — reassign technician for today's visits (M15)
//   Body: { fromTechnicianId, toTechnicianId, scope: "remaining"|"all",
//           note?, notify }
// ==========================================================================
roundsRouter.post(
  "/:id/reassign",
  h(async (req, res) => {
    const body = asObject(req.body);
    const rawScope = requireString(body.scope, "scope");
    if (rawScope !== "remaining" && rawScope !== "all") {
      throw new AppError(400, '"scope" must be "remaining" or "all"');
    }
    const input: ReassignInput = {
      fromTechnicianId: requireString(body.fromTechnicianId, "fromTechnicianId"),
      toTechnicianId: requireString(body.toTechnicianId, "toTechnicianId"),
      scope: rawScope,
      note: optString(body.note, "note"),
      notify: optBool(body.notify, "notify") ?? false,
    };
    const result = await svc(req).reassignTechnician(actorIdOf(req), req.params.id, input);
    void createReportsService(req.tenantPrisma!).logActivity(
      "TECHNICIAN_REASSIGNED",
      `Technician reassigned in round: ${req.params.id}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);

// ==========================================================================
// POST /rounds/:id/push-missed — push today's SCHEDULED visits to new date (M22)
//   Body: { newDate: "YYYY-MM-DD", reason, technicianId?, notifyCustomers }
// ==========================================================================
roundsRouter.post(
  "/:id/push-missed",
  h(async (req, res) => {
    const body = asObject(req.body);
    const rawDate = requireString(body.newDate, "newDate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      throw new AppError(400, '"newDate" must be a YYYY-MM-DD date');
    }
    const input: PushMissedInput = {
      newDate: parseIsoDate(body.newDate, "newDate"),
      reason: requireString(body.reason, "reason"),
      technicianId: optId(body.technicianId, "technicianId"),
      notifyCustomers: optBool(body.notifyCustomers, "notifyCustomers") ?? false,
    };
    const result = await svc(req).pushMissedJobs(actorIdOf(req), req.params.id, input);
    void createReportsService(req.tenantPrisma!).logActivity(
      "VISITS_PUSHED",
      `Visits pushed to ${input.newDate.toISOString().slice(0, 10)} in round: ${req.params.id}`,
      req.profile?.id,
      req.profile?.role ?? undefined,
    );
    res.json(result);
  })
);
