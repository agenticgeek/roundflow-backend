import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { IncidentType } from "../generated/tenant-client";
import {
  asObject,
  h,
  optBool,
  optId,
  optNumber,
  optReqString,
  optString,
  optStringArray,
  parsePageParams,
  requireString,
} from "../lib/http";
import {
  assertNonNegative,
  isValidEmail,
  optIsoDate,
  optTechnicianRole,
  parseIsoDate,
  parseOptionalDateOnly,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
} from "../lib/validation";
import { sendInviteEmail } from "../lib/email";
import { assertNoActiveInvite, buildInviteUrl, newInviteExpiry } from "../lib/invites";
import {
  createTechnicianService,
  CreateTechnicianInput,
  UpdateTechnicianInput,
} from "../services/technician.service";
import { createPhotoGalleryService } from "../services/photo-gallery.service";
import { createTechnicianIncidentService } from "../services/technician-incident.service";
import { createTechnicianAvailabilityService } from "../services/technician-availability.service";
import { parseKpiPeriod } from "../services/technician-kpi.service";

export const techniciansRouter = Router();
techniciansRouter.use(requireAuth);
techniciansRouter.use(requireTenantAccess);
techniciansRouter.use(requireBusinessAccess());

const svc = (req: Request) => createTechnicianService(req.tenantPrisma!);

// Thin routes: validate → call service → respond.

// GAP-004: older web builds send a singular `serviceAreaId`. Fold it into
// `serviceAreaIds` so it isn't silently dropped. undefined = neither sent.
function readServiceAreaIds(body: Record<string, unknown>): string[] | undefined {
  const ids = optStringArray(body.serviceAreaIds, "serviceAreaIds");
  const single = optId(body.serviceAreaId, "serviceAreaId");
  if (!single) return ids;
  return [...(ids ?? []), single];
}

// GET /technicians
techniciansRouter.get(
  "/",
  h(async (req, res) => {
    const service = svc(req);
    const technicians = await service.listTechnicians();
    return res.json(technicians);
  })
);

// GET /technicians/:id
techniciansRouter.get(
  "/:id",
  h(async (req, res) => {
    const service = svc(req);
    const technician = await service.getTechnicianDetail(req.params.id);
    return res.json(technician);
  })
);

// POST /technicians
techniciansRouter.post(
  "/",
  h(async (req, res) => {
    const body = asObject(req.body);

    const name = optReqString(body.name, "name", { maxLength: MAX_NAME_LENGTH }) ?? null;
    const phone = optString(body.phone, "phone") ?? null;
    const role = optTechnicianRole(body.role) ?? null;
    const emailRaw = optString(body.email, "email") ?? null;
    const notes = optString(body.notes, "notes", { maxLength: MAX_NOTES_LENGTH }) ?? null;
    const serviceAreaIds = readServiceAreaIds(body);
    const sendInvite = optBool(body.sendInvite, "sendInvite") ?? false;

    let email: string | null = null;
    if (emailRaw !== null) {
      email = emailRaw.toLowerCase().trim();
      if (!isValidEmail(email)) throw new AppError(400, "Invalid email address");
    }

    if (sendInvite && !email) {
      throw new AppError(400, '"email" is required when sendInvite is true');
    }

    // Check for a duplicate pending invite BEFORE creating the technician so a
    // 409 doesn't leave an orphaned technician row in the DB.
    if (sendInvite && email) {
      await assertNoActiveInvite(
        req.profile!.tenantId,
        email,
        "A pending invite for this email already exists. Use POST /invites/:id/resend to resend."
      );
    }

    const input: CreateTechnicianInput = { name, phone, role, email, notes, serviceAreaIds };
    const service = svc(req);
    const tech = await service.createTechnician(input);

    if (sendInvite && email) {
      const profile = req.profile!;

      const invite = await prisma.tenantInvite.create({
        data: {
          tenantId: profile.tenantId,
          email,
          role: UserRole.TECHNICIAN,
          technicianId: tech.id,
          expiresAt: newInviteExpiry(),
        },
      });

      try {
        await sendInviteEmail({ to: email, inviteUrl: buildInviteUrl(invite.token) });
      } catch {
        await prisma.tenantInvite.delete({ where: { id: invite.id } }).catch((rollbackErr) => {
          console.error("[technicians] Failed to roll back invite after email failure:", rollbackErr);
          throw new AppError(503, "Email delivery failed and invite could not be cleaned up. Use POST /invites to retry after the pending invite is cleared.");
        });
        throw new AppError(
          503,
          "Technician created but invite email failed. Retry with POST /invites."
        );
      }
    }

    return res.status(201).json(tech);
  })
);

// PATCH /technicians/:id
techniciansRouter.patch(
  "/:id",
  h(async (req, res) => {
    const body = asObject(req.body);

    const input: UpdateTechnicianInput = {
      name: optString(body.name, "name", { maxLength: MAX_NAME_LENGTH }),
      phone: optString(body.phone, "phone"),
      role: optTechnicianRole(body.role),
      notes: optString(body.notes, "notes", { maxLength: MAX_NOTES_LENGTH }),
      active: optBool(body.active, "active"),
      serviceAreaIds: readServiceAreaIds(body),
    };

    // Email validated separately to normalise case
    const emailRaw = optString(body.email, "email");
    if (emailRaw !== undefined && emailRaw !== null) {
      const normalised = emailRaw.toLowerCase().trim();
      if (!isValidEmail(normalised)) throw new AppError(400, "Invalid email address");
      input.email = normalised;
    } else {
      input.email = emailRaw; // undefined or null — pass through
    }

    const service = svc(req);
    const tech = await service.updateTechnician(req.params.id, input);
    return res.json(tech);
  })
);

// ==========================================================================
// GET /technicians/:id/performance?period=thisMonth (GAP-030)
// → { technicianId, period, from, to, visitsCompleted, revenue, timeOnJobMinutes,
//     revenuePerHour, strikes, damages, upsells, upsellValue, complaints }
// ==========================================================================
techniciansRouter.get(
  "/:id/performance",
  h(async (req, res) => {
    const period = parseKpiPeriod(req.query.period, "thisMonth");
    res.json(await svc(req).getPerformance(req.params.id, period, new Date()));
  })
);

// ==========================================================================
// GET /technicians/:id/photos?page&pageSize (B4 · GAP-019)
// ==========================================================================
techniciansRouter.get(
  "/:id/photos",
  h(async (req, res) => {
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, {
      defaultPageSize: 24,
      maxPageSize: 100,
    });
    res.json(
      await createPhotoGalleryService(req.tenantPrisma!).listTechnicianPhotos(req.params.id, { page, pageSize })
    );
  })
);

// ==========================================================================
// Incidents (B6 · GAP-025). DELETE lives on /technician-incidents/:id.
// ==========================================================================
const INCIDENT_TYPES = Object.values(IncidentType) as string[];

// POST /technicians/:id/incidents { type, amount?, note, visitId? } → 201 incident
techniciansRouter.post(
  "/:id/incidents",
  h(async (req, res) => {
    const body = asObject(req.body);
    if (typeof body.type !== "string" || !INCIDENT_TYPES.includes(body.type)) {
      throw new AppError(400, `type must be one of: ${INCIDENT_TYPES.join(", ")}`);
    }
    const amount = optNumber(body.amount, "amount");
    if (amount !== undefined && amount !== null) assertNonNegative(amount, "amount", 99_999_999);
    const incident = await createTechnicianIncidentService(req.tenantPrisma!).create(req.params.id, {
      type: body.type as IncidentType,
      amount,
      note: requireString(body.note, "note", { maxLength: MAX_NOTES_LENGTH }),
      visitId: optId(body.visitId, "visitId"),
      createdById: req.profile?.id ?? null,
    });
    res.status(201).json(incident);
  })
);

// GET /technicians/:id/incidents?type&from&to&page&pageSize → { rows, pagination }
techniciansRouter.get(
  "/:id/incidents",
  h(async (req, res) => {
    const type = req.query.type;
    if (type !== undefined && (typeof type !== "string" || !INCIDENT_TYPES.includes(type))) {
      throw new AppError(400, `type must be one of: ${INCIDENT_TYPES.join(", ")}`);
    }
    const from = parseOptionalDateOnly(req.query.from, "from");
    const to = parseOptionalDateOnly(req.query.to, "to");
    if (from && to && to < from) throw new AppError(400, '"to" must not be before "from"');
    const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, {
      defaultPageSize: 50,
      maxPageSize: 100,
    });
    res.json(
      await createTechnicianIncidentService(req.tenantPrisma!).list(req.params.id, {
        type: type as IncidentType | undefined,
        from,
        to,
        page,
        pageSize,
      })
    );
  })
);

// ==========================================================================
// Availability (GAP-030)
// ==========================================================================

// GET /technicians/:id/availability → [{ id, technicianId, from, to, reason, createdAt }]
techniciansRouter.get(
  "/:id/availability",
  h(async (req, res) => {
    res.json(await createTechnicianAvailabilityService(req.tenantPrisma!).list(req.params.id));
  })
);

// POST /technicians/:id/availability { from, to, reason? } → 201 { ...row, visitsRestamped }
techniciansRouter.post(
  "/:id/availability",
  h(async (req, res) => {
    const body = asObject(req.body);
    const from = parseIsoDate(body.from, "from");
    const to = parseIsoDate(body.to, "to");
    if (to < from) throw new AppError(400, '"to" must not be before "from"');
    const row = await createTechnicianAvailabilityService(req.tenantPrisma!).create(
      req.params.id,
      { from, to, reason: optString(body.reason, "reason", { maxLength: MAX_NOTES_LENGTH }) },
      new Date()
    );
    res.status(201).json(row);
  })
);

// DELETE /technicians/:id/availability/:availabilityId → 204
techniciansRouter.delete(
  "/:id/availability/:availabilityId",
  h(async (req, res) => {
    await createTechnicianAvailabilityService(req.tenantPrisma!).remove(
      req.params.id,
      req.params.availabilityId,
      new Date()
    );
    res.status(204).send();
  })
);

// POST /technicians/:id/replace { replacementTechnicianId, from, to?, notify? } → { visitsReassigned }
techniciansRouter.post(
  "/:id/replace",
  h(async (req, res) => {
    const body = asObject(req.body);
    const from = parseIsoDate(body.from, "from");
    const to = optIsoDate(body.to, "to");
    if (to && to < from) throw new AppError(400, '"to" must not be before "from"');
    res.json(
      await createTechnicianAvailabilityService(req.tenantPrisma!).replace(req.params.id, {
        replacementTechnicianId: requireString(body.replacementTechnicianId, "replacementTechnicianId"),
        from,
        to,
        notify: optBool(body.notify, "notify") ?? true,
      })
    );
  })
);
