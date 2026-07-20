import { Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h, asObject, requireString, optString } from "../lib/http";
import { sendInviteEmail } from "../lib/email";

export const invitesRouter = Router();

const INVITE_TTL_DAYS = 7;

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function assertInviteUsable(invite: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): void {
  if (invite.acceptedAt) throw new AppError(410, "Invite has already been accepted");
  if (invite.expiresAt < new Date()) throw new AppError(410, "Invite has expired");
}

// POST /invites — admin/manager sends an email invite
invitesRouter.post(
  "/",
  requireAuth,
  requireTenantAccess,
  requireRole(UserRole.ADMIN, UserRole.MANAGER),
  h(async (req, res) => {
    const profile = req.profile!;
    const body = asObject(req.body);

    const email = requireString(body.email, "email").toLowerCase().trim();
    if (!isValidEmail(email)) throw new AppError(400, "Invalid email address");

    const roleRaw = optString(body.role, "role") ?? UserRole.TECHNICIAN;
    if (!Object.values(UserRole).includes(roleRaw as UserRole)) {
      throw new AppError(400, `role must be one of: ${Object.values(UserRole).join(", ")}`);
    }
    const role = roleRaw as UserRole;

    const technicianId = optString(body.technicianId, "technicianId") ?? null;
    if (technicianId) {
      const tech = await req.tenantPrisma!.technician.findUnique({ where: { id: technicianId } });
      if (!tech) throw new AppError(404, "Technician not found");
      if (tech.profileId !== null)
        throw new AppError(409, "Technician has already accepted an invite");
    }

    const existing = await prisma.tenantInvite.findFirst({
      where: { tenantId: profile.tenantId, email, acceptedAt: null },
    });
    if (existing) throw new AppError(409, "A pending invite for this email already exists");

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);

    const invite = await prisma.tenantInvite.create({
      data: { tenantId: profile.tenantId, email, role, technicianId, expiresAt },
    });

    const settings = await req.tenantPrisma!.businessSettings.findFirst();
    const base = process.env.INVITE_BASE_URL ?? "";
    await sendInviteEmail({
      to: email,
      inviteUrl: `${base}/accept-invite?token=${invite.token}`,
      businessName: settings?.businessName,
    });

    return res.status(201).json(invite);
  })
);

// GET /invites/:token — public; used by the frontend before auth to pre-fill signup
invitesRouter.get(
  "/:token",
  h(async (req, res) => {
    const invite = await prisma.tenantInvite.findUnique({
      where: { token: req.params.token },
    });
    if (!invite) throw new AppError(404, "Invite not found");
    assertInviteUsable(invite);

    return res.json({
      email: invite.email,
      role: invite.role,
      tenantId: invite.tenantId,
      expiresAt: invite.expiresAt,
    });
  })
);

// POST /invites/:token/accept — invitee calls this after authenticating via Supabase
invitesRouter.post(
  "/:token/accept",
  requireAuth,
  h(async (req, res) => {
    const invite = await prisma.tenantInvite.findUnique({
      where: { token: req.params.token },
    });
    if (!invite) throw new AppError(404, "Invite not found");
    assertInviteUsable(invite);

    if (req.user!.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new AppError(403, "This invite was sent to a different email address");
    }

    // Idempotent: return existing profile if the invitee already accepted
    const existing = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user!.supabaseUserId },
    });
    if (existing) return res.json({ profile: existing });

    const body = asObject(req.body);
    const name = requireString(body.name, "name").trim();
    if (!name) throw new AppError(400, "name must not be blank");

    const profile = await prisma.$transaction(async (tx) => {
      const p = await tx.profile.create({
        data: {
          supabaseUserId: req.user!.supabaseUserId,
          tenantId: invite.tenantId,
          role: invite.role,
          name,
        },
      });
      await tx.tenantInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      return p;
    });

    if (invite.technicianId) {
      const tenant = await prisma.tenant.findUnique({ where: { id: invite.tenantId } });
      if (tenant) {
        await getTenantPrismaForSchema(tenant.schemaName).technician.update({
          where: { id: invite.technicianId },
          data: { profileId: profile.id },
        });
      }
    }

    return res.status(201).json({ profile });
  })
);
