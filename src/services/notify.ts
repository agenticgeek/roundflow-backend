import { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { categoryPushEnabled } from "../lib/notification-prefs";
import { getSchemaNameForClient, getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createNotificationService, type NotificationData } from "../mobile/services/notification.service";

// Central notification producer (NOTIF-01/02/03, FLOW-03). Every event that
// should reach a technician or the office goes through notifyEvent(): it
// resolves recipients, dedupes, applies push preferences and writes the
// Notification row (+ push) via NotificationService.
//
// Best effort by contract: it NEVER throws into the caller (the business action
// has already succeeded), failures are logged and counted as "not sent".

export type NotificationType =
  | "SCHEDULE"
  | "ROUND_UPDATE"
  | "CHAT"
  | "PAYMENT"
  | "COMPLAINT"
  | "ACCESS_ISSUE"
  | "DAY_CLOSED"
  | "INVITE"
  | "KPI_ALERT"
  | "INTEGRATION";

export interface NotifyRecipients {
  /** Technician ids; resolved to profiles. Inactive / not-yet-accepted technicians are skipped. */
  technicianIds?: string[];
  /** Explicit public Profile ids. */
  profileIds?: string[];
  /** Every ADMIN and MANAGER profile of the tenant that owns the client. */
  admins?: boolean;
  excludeProfileIds?: string[];
}

export interface NotifyEvent {
  type: NotificationType;
  title: string;
  body?: string;
  data?: NotificationData;
  to: NotifyRecipients;
  /** Skip a recipient who already has an UNREAD notification of the same type,
   *  created within windowMs, whose data matches on every listed key. */
  dedupe?: { windowMs: number; keys: Array<keyof NotificationData> };
}

async function resolveProfileIds(tp: TenantPrismaClient, to: NotifyRecipients): Promise<string[]> {
  const ids = new Set<string>(to.profileIds ?? []);

  if (to.technicianIds && to.technicianIds.length > 0) {
    const techs = await tp.technician.findMany({
      where: { id: { in: to.technicianIds }, active: true, profileId: { not: null } },
      select: { profileId: true },
    });
    // The query already excludes technicians without a profile.
    for (const t of techs) ids.add(t.profileId as string);
  }

  if (to.admins) {
    const schemaName = getSchemaNameForClient(tp);
    if (schemaName) {
      const admins = await prisma.profile.findMany({
        where: { tenant: { schemaName }, role: { in: [UserRole.ADMIN, UserRole.MANAGER] } },
        select: { id: true },
      });
      for (const a of admins) ids.add(a.id);
    }
  }

  for (const id of to.excludeProfileIds ?? []) ids.delete(id);
  return [...ids];
}

// profileId -> push allowed. Fails open: a preference lookup problem must not
// silence notifications.
async function pushAllowed(profileIds: string[], type: string): Promise<Map<string, boolean>> {
  const allowed = new Map<string, boolean>(profileIds.map((id) => [id, true]));
  try {
    const rows = await prisma.profile.findMany({
      where: { id: { in: profileIds } },
      select: { id: true, preferences: true },
    });
    for (const r of rows) allowed.set(r.id, categoryPushEnabled(r.preferences, type));
  } catch (err) {
    console.error("[notify] preference lookup failed, defaulting to push on:", err);
  }
  return allowed;
}

async function alreadyNotified(tp: TenantPrismaClient, profileId: string, event: NotifyEvent): Promise<boolean> {
  const { windowMs, keys } = event.dedupe!;
  const found = await tp.notification.findFirst({
    where: {
      profileId,
      type: event.type,
      read: false,
      createdAt: { gte: new Date(Date.now() - windowMs) },
      AND: keys
        .filter((k) => event.data?.[k] !== undefined)
        .map((k) => ({ data: { path: [k], equals: event.data![k] } })),
    },
    select: { id: true },
  });
  return found !== null;
}

/** Returns how many notifications were created. Never throws. */
export async function notifyEvent(tp: TenantPrismaClient, event: NotifyEvent): Promise<number> {
  try {
    const profileIds = await resolveProfileIds(tp, event.to);
    if (profileIds.length === 0) return 0;

    const push = await pushAllowed(profileIds, event.type);
    const notifications = createNotificationService(tp);

    const results = await Promise.allSettled(
      profileIds.map(async (profileId) => {
        if (event.dedupe && (await alreadyNotified(tp, profileId, event))) return false;
        await notifications.create(profileId, event.type, event.title, event.body, event.data, {
          push: push.get(profileId) !== false,
        });
        return true;
      })
    );
    for (const r of results) {
      if (r.status === "rejected") console.error(`[notify] ${event.type} failed for a recipient:`, r.reason);
    }
    return results.filter((r) => r.status === "fulfilled" && r.value).length;
  } catch (err) {
    console.error(`[notify] ${event.type} failed:`, err);
    return 0;
  }
}

// ---- convenience wrappers used by the producers ---------------------------

/** Notify every ADMIN and MANAGER of the tenant that owns `tp`. */
export function notifyAdmins(
  tp: TenantPrismaClient,
  event: Omit<NotifyEvent, "to"> & { excludeProfileIds?: string[] }
): Promise<number> {
  const { excludeProfileIds, ...rest } = event;
  return notifyEvent(tp, { ...rest, to: { admins: true, excludeProfileIds } });
}

/** Like notifyAdmins, for callers that only know the tenant id (public-schema code such as invites). */
export async function notifyTenantAdmins(
  tenantId: string,
  event: Omit<NotifyEvent, "to"> & { excludeProfileIds?: string[] }
): Promise<number> {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { schemaName: true } });
    if (!tenant) return 0;
    return await notifyAdmins(getTenantPrismaForSchema(tenant.schemaName), event);
  } catch (err) {
    console.error(`[notify] ${event.type} failed:`, err);
    return 0;
  }
}

export interface VisitRef {
  id: string;
  technicianId: string | null;
  date: Date;
  roundId?: string | null;
  propertyId?: string | null;
}

/**
 * One notification per technician about a set of visits (assigned, moved,
 * cancelled, held ...). `message` builds the wording from the technician's
 * visit count and earliest date. data.date is that earliest date; a single
 * visit also carries visitId/propertyId, and roundId is included when every
 * visit of the technician is on the same round. Unassigned visits are ignored.
 */
export async function notifyVisitTechnicians(
  tp: TenantPrismaClient,
  visits: VisitRef[],
  message: (info: { count: number; first: string }) => { type: NotificationType; title: string; body?: string },
  extraData: NotificationData = {}
): Promise<void> {
  const byTechnician = new Map<string, VisitRef[]>();
  for (const v of visits) {
    if (!v.technicianId) continue;
    byTechnician.set(v.technicianId, [...(byTechnician.get(v.technicianId) ?? []), v]);
  }
  for (const [technicianId, mine] of byTechnician) {
    const first = mine.map((v) => v.date.toISOString().slice(0, 10)).sort()[0];
    const roundIds = new Set(mine.map((v) => v.roundId ?? null));
    const [onlyRound] = roundIds;
    const data: NotificationData = {
      ...(mine.length === 1 ? { visitId: mine[0].id, ...(mine[0].propertyId ? { propertyId: mine[0].propertyId } : {}) } : {}),
      ...(roundIds.size === 1 && onlyRound ? { roundId: onlyRound } : {}),
      date: first,
      ...extraData,
    };
    await notifyEvent(tp, { ...message({ count: mine.length, first }), data, to: { technicianIds: [technicianId] } });
  }
}

/** "1 visit" / "3 visits". */
export const visitCount = (n: number): string => `${n} ${n === 1 ? "visit" : "visits"}`;

async function customerName(tp: TenantPrismaClient, customerId: string): Promise<string> {
  const c = await tp.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  return c?.name ?? "A customer";
}

/** NOTIF-03: an invoice became PAID. `excludeProfileId` = the admin who did it by hand. Never throws. */
export async function notifyInvoicePaid(
  tp: TenantPrismaClient,
  invoice: { id: string; invoiceNumber: string; customerId: string },
  excludeProfileId?: string | null
): Promise<void> {
  try {
    await notifyAdmins(tp, {
      type: "PAYMENT",
      title: "Invoice paid",
      body: `${await customerName(tp, invoice.customerId)} paid invoice ${invoice.invoiceNumber}.`,
      data: { invoiceId: invoice.id, customerId: invoice.customerId },
      excludeProfileIds: excludeProfileId ? [excludeProfileId] : undefined,
    });
  } catch (err) {
    console.error("[notify] PAYMENT failed:", err);
  }
}

/** NOTIF-03: a customer payment failed. Never throws. */
export async function notifyPaymentFailed(tp: TenantPrismaClient, customerId: string): Promise<void> {
  try {
    await notifyAdmins(tp, {
      type: "PAYMENT",
      title: "Payment failed",
      body: `A payment from ${await customerName(tp, customerId)} failed.`,
      data: { customerId },
    });
  } catch (err) {
    console.error("[notify] PAYMENT failed:", err);
  }
}

/** Wave 2B-1 (BE-08): a refund, dispute or dispute outcome on a payment. Office only. Never throws. */
export async function notifyPaymentEvent(
  tp: TenantPrismaClient,
  event: { customerId: string; invoiceId?: string; title: string; body?: string }
): Promise<void> {
  try {
    const name = await customerName(tp, event.customerId);
    await notifyAdmins(tp, {
      type: "PAYMENT",
      title: event.title,
      body: event.body ? `${name}: ${event.body}` : `A payment from ${name} needs attention.`,
      data: { customerId: event.customerId, ...(event.invoiceId ? { invoiceId: event.invoiceId } : {}) },
    });
  } catch (err) {
    console.error("[notify] PAYMENT failed:", err);
  }
}

/** Wave 2B-1 (BE-12): an integration queue row ran out of retries ("dead"). Office only. Never throws (notifyEvent swallows). */
export async function notifyIntegrationDead(
  tp: TenantPrismaClient,
  row: { id: string; eventType: string; lastError?: string | null }
): Promise<void> {
  // notifyAdmins never throws (notifyEvent swallows and logs), so no try/catch is needed here.
  await notifyAdmins(tp, {
    type: "INTEGRATION",
    title: "Integration message failed",
    body: `${row.eventType} could not be delivered after several attempts. Open Integrations to retry it.`,
    dedupe: { windowMs: 3_600_000, keys: [] },
  });
}
