import { Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema } from "../lib/tenant-prisma-manager";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { AppError } from "../lib/app-error";
import { h, asObject, requireString, optString } from "../lib/http";
import { sendInviteEmail } from "../lib/email";
import { assertNoActiveInvite, buildInviteUrl, newInviteExpiry } from "../lib/invites";
import { isValidEmail } from "../lib/validation";

export const invitesRouter = Router();

function assertInviteUsable(invite: {
  acceptedAt: Date | null;
  expiresAt: Date;
}): void {
  if (invite.acceptedAt) throw new AppError(410, "Invite has already been accepted", "INVITE_ACCEPTED");
  if (invite.expiresAt < new Date()) throw new AppError(410, "Invite has expired", "INVITE_EXPIRED");
}

// Tenant-scoped lookup for the admin cancel/resend endpoints. An accepted invite
// can't be cancelled or resent — the person is already a member.
async function findPendingInvite(id: string, tenantId: string) {
  const invite = await prisma.tenantInvite.findFirst({ where: { id, tenantId } });
  if (!invite) throw new AppError(404, "Invite not found");
  if (invite.acceptedAt) {
    throw new AppError(409, "Invite has already been accepted", "INVITE_ACCEPTED");
  }
  return invite;
}

// GET /invites — admin/manager lists invites not yet accepted (expired included,
// flagged, so they can be resent). Tokens are left out: the list doesn't need them.
invitesRouter.get(
  "/",
  requireAuth,
  requireTenantAccess,
  requireBusinessAccess(),
  h(async (req, res) => {
    const invites = await prisma.tenantInvite.findMany({
      where: { tenantId: req.profile!.tenantId, acceptedAt: null },
      select: { id: true, email: true, role: true, technicianId: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const now = new Date();
    return res.json(invites.map((invite) => ({ ...invite, expired: invite.expiresAt < now })));
  })
);

// POST /invites — admin/manager sends an email invite
invitesRouter.post(
  "/",
  requireAuth,
  requireTenantAccess,
  requireBusinessAccess(),
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

    await assertNoActiveInvite(
      profile.tenantId,
      email,
      "A pending invite for this email already exists"
    );

    const invite = await prisma.tenantInvite.create({
      data: { tenantId: profile.tenantId, email, role, technicianId, expiresAt: newInviteExpiry() },
    });

    try {
      await sendInviteEmail({ to: email, inviteUrl: buildInviteUrl(invite.token) });
    } catch {
      // Roll back the invite row so the admin can retry without hitting 409.
      await prisma.tenantInvite.delete({ where: { id: invite.id } }).catch((rollbackErr) => {
        console.error("[invites] Failed to roll back invite after email failure:", rollbackErr);
        throw new AppError(503, "Email delivery failed and invite could not be cleaned up. Contact support to remove the pending invite before retrying.");
      });
      throw new AppError(503, "Invite created but email delivery failed. Please try again.");
    }

    return res.status(201).json(invite);
  })
);

// DELETE /invites/:id — admin/manager cancels a pending invite. The old email
// link then 404s ("Invite not found").
invitesRouter.delete(
  "/:id",
  requireAuth,
  requireTenantAccess,
  requireBusinessAccess(),
  h(async (req, res) => {
    const invite = await findPendingInvite(req.params.id, req.profile!.tenantId);
    await prisma.tenantInvite.delete({ where: { id: invite.id } });
    return res.status(204).send();
  })
);

// POST /invites/:id/resend — admin/manager re-sends the email and resets the
// 7-day expiry. The token is unchanged, so earlier emails' links keep working.
// Email is sent first so a delivery failure leaves the invite untouched.
invitesRouter.post(
  "/:id/resend",
  requireAuth,
  requireTenantAccess,
  requireBusinessAccess(),
  h(async (req, res) => {
    const invite = await findPendingInvite(req.params.id, req.profile!.tenantId);
    try {
      await sendInviteEmail({ to: invite.email, inviteUrl: buildInviteUrl(invite.token) });
    } catch (err) {
      console.error("[invites] Resend email failed:", err);
      throw new AppError(503, "Invite email failed to send. Please try again.");
    }
    const updated = await prisma.tenantInvite.update({
      where: { id: invite.id },
      data: { expiresAt: newInviteExpiry() },
    });
    return res.json(updated);
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

    // Idempotency check BEFORE assertInviteUsable: if the process crashed after
    // the profile+acceptedAt transaction committed but before the Technician
    // update ran, invite.acceptedAt is already set and assertInviteUsable would
    // throw 410 — making the tech-link completion permanently unreachable.
    const existing = await prisma.profile.findUnique({
      where: { supabaseUserId: req.user!.supabaseUserId },
    });
    if (existing) {
      // Guard 1: invite must belong to the same tenant as this user's profile.
      if (existing.tenantId !== invite.tenantId) {
        throw new AppError(403, "This invite belongs to a different organisation");
      }
      // Guard 2: invite must have been sent to this user's email address.
      if (req.user!.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new AppError(403, "This invite was sent to a different email address");
      }
      if (invite.technicianId) {
        const tenant = await prisma.tenant.findUnique({ where: { id: invite.tenantId } });
        if (tenant) {
          const tPrisma = getTenantPrismaForSchema(tenant.schemaName);
          const tech = await tPrisma.technician.findUnique({ where: { id: invite.technicianId } });
          if (tech && tech.profileId === null) {
            await tPrisma.technician.update({
              where: { id: invite.technicianId },
              data: { profileId: existing.id },
            });
          }
        }
      }
      return res.json({ profile: existing });
    }

    // No existing profile — verify the invite is still usable for a fresh accept.
    assertInviteUsable(invite);

    if (req.user!.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new AppError(403, "This invite was sent to a different email address");
    }

    const body = asObject(req.body);
    // requireString already rejects blank/whitespace-only names.
    const name = requireString(body.name, "name").trim();

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
        try {
          await getTenantPrismaForSchema(tenant.schemaName).technician.update({
            where: { id: invite.technicianId },
            data: { profileId: profile.id },
          });
        } catch (linkErr) {
          // Profile and acceptedAt are already committed. The idempotency guard in this
          // endpoint re-attempts the tech-link on the next call, so signing in again recovers.
          console.error("[invites] Technician link failed after profile commit:", linkErr);
          throw new AppError(
            500,
            "Account created but technician link failed. Please sign in again to complete setup."
          );
        }
      }
    }

    return res.status(201).json({ profile });
  })
);
