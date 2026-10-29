import { prisma } from "./prisma";
import { AppError } from "./app-error";
import { INVITE_TTL_DAYS } from "./email";

// Shared by /invites and POST /technicians (sendInvite), which both create
// TenantInvite rows.

export function newInviteExpiry(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);
  return expiresAt;
}

export function buildInviteUrl(token: string): string {
  return `${process.env.INVITE_BASE_URL!}/accept-invite?token=${token}`;
}

// 409 if an unaccepted, unexpired invite already exists for this email. Expired
// unaccepted invites don't block a new one; they're deleted so the new invite
// replaces them instead of piling up in GET /invites.
export async function assertNoActiveInvite(
  tenantId: string,
  email: string,
  conflictMessage: string
): Promise<void> {
  const now = new Date();
  const active = await prisma.tenantInvite.findFirst({
    where: { tenantId, email, acceptedAt: null, expiresAt: { gt: now } },
  });
  if (active) throw new AppError(409, conflictMessage);

  await prisma.tenantInvite.deleteMany({
    where: { tenantId, email, acceptedAt: null, expiresAt: { lte: now } },
  });
}
