import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { asObject, h, optBool, optId, optReqString, optString } from "../lib/http";
import { isValidEmail } from "../lib/validation";
import { sendInviteEmail, INVITE_TTL_DAYS } from "../lib/email";
import {
  createTechnicianService,
  CreateTechnicianInput,
  UpdateTechnicianInput,
} from "../services/technician.service";

export const techniciansRouter = Router();
techniciansRouter.use(requireAuth);
techniciansRouter.use(requireTenantAccess);
techniciansRouter.use(requireRole(UserRole.ADMIN, UserRole.MANAGER));

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

    const name = optReqString(body.name, "name") ?? null;
    const phone = optString(body.phone, "phone") ?? null;
    const role = optString(body.role, "role") ?? null;
    const emailRaw = optString(body.email, "email") ?? null;
    const notes = optString(body.notes, "notes") ?? null;
    const serviceAreaId = optId(body.serviceAreaId, "serviceAreaId") ?? null;
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
      const existing = await prisma.tenantInvite.findFirst({
        where: { tenantId: req.profile!.tenantId, email, acceptedAt: null },
      });
      if (existing) {
        throw new AppError(
          409,
          "A pending invite for this email already exists. Use POST /invites to resend."
        );
      }
    }

    const input: CreateTechnicianInput = { name, phone, role, email, notes, serviceAreaId };
    const service = svc(req);
    const tech = await service.createTechnician(input);

    if (sendInvite && email) {
      const profile = req.profile!;

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);

      const invite = await prisma.tenantInvite.create({
        data: {
          tenantId: profile.tenantId,
          email,
          role: UserRole.TECHNICIAN,
          technicianId: tech.id,
          expiresAt,
        },
      });

      const settings = await req.tenantPrisma!.businessSettings.findFirst({
        select: { businessName: true },
      });
      const base = process.env.INVITE_BASE_URL!;
      try {
        await sendInviteEmail({
          to: email,
          inviteUrl: `${base}/accept-invite?token=${invite.token}`,
          businessName: settings?.businessName,
        });
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
      name: optString(body.name, "name"),
      phone: optString(body.phone, "phone"),
      role: optString(body.role, "role"),
      notes: optString(body.notes, "notes"),
      active: optBool(body.active, "active"),
      serviceAreaId: optId(body.serviceAreaId, "serviceAreaId"),
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
