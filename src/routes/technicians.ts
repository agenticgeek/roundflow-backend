import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, optBool, optReqString, optString, optStringArray } from "../lib/http";
import { isValidEmail, optTechnicianRole, MAX_NAME_LENGTH, MAX_NOTES_LENGTH } from "../lib/validation";
import { sendInviteEmail } from "../lib/email";
import { assertNoActiveInvite, buildInviteUrl, newInviteExpiry } from "../lib/invites";
import {
  createTechnicianService,
  CreateTechnicianInput,
  UpdateTechnicianInput,
} from "../services/technician.service";

export const techniciansRouter = Router();
techniciansRouter.use(requireAuth);
techniciansRouter.use(requireTenantAccess);
techniciansRouter.use(requireBusinessAccess());

const svc = (req: Request) => createTechnicianService(req.tenantPrisma!);

// Thin routes: validate → call service → respond.

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
    const serviceAreaIds = optStringArray(body.serviceAreaIds, "serviceAreaIds");
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
      serviceAreaIds: optStringArray(body.serviceAreaIds, "serviceAreaIds"),
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
