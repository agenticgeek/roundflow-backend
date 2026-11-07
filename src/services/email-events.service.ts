import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { MessageChannel, MessageDeliveryStatus, MessageDirection } from "../generated/tenant-client";
import { notifyAdmins } from "./notify";

// SES events -> Message.deliveryStatus, Customer.emailInvalidAt and the per-tenant auto-pause (GHL-07).
// A delivery status only ever moves "up" (SENT < DELIVERED < BOUNCED < COMPLAINED), so a late Delivery event
// can never hide a bounce or a complaint.

export const HEALTH = {
  minSample: 100,
  complaintRate: 0.003,
  bounceRate: 0.05,
  /** Absolute triggers within `windowDays`, regardless of volume (protects a tiny tenant). */
  windowDays: 7,
  maxComplaints: 3,
  maxHardBounces: 10,
} as const;

/** A hard bounce is recorded as deliveryError "Permanent/<subtype>"; transient bounces never count towards pausing. */
export const isHardBounce = (m: { deliveryStatus: string | null; deliveryError?: string | null }): boolean =>
  m.deliveryStatus === S.BOUNCED && (m.deliveryError ?? "").startsWith("Permanent");

export interface SesEvent {
  type: "Delivery" | "Bounce" | "Complaint";
  messageId: string;
  tenantId?: string;
  permanent?: boolean;
  detail?: string;
}

type Raw = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; tags?: Record<string, unknown> };
  bounce?: { bounceType?: string; bounceSubType?: string };
  complaint?: { complaintFeedbackType?: string };
};

export function tenantIdOf(raw: unknown): string | undefined {
  const tag = (raw as Raw | null)?.mail?.tags?.tenantId;
  return Array.isArray(tag) && typeof tag[0] === "string" ? tag[0] : undefined;
}

export function parseSesEvent(raw: unknown): SesEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Raw;
  const type = r.eventType ?? r.notificationType;
  const messageId = r.mail?.messageId;
  if (!messageId || (type !== "Delivery" && type !== "Bounce" && type !== "Complaint")) return null;
  const base = { type, messageId, tenantId: tenantIdOf(raw) } as const;
  if (type === "Delivery") return base;
  if (type === "Bounce") {
    const bounceType = r.bounce?.bounceType ?? "Transient";
    return { ...base, permanent: bounceType === "Permanent", detail: `${bounceType}/${r.bounce?.bounceSubType ?? "Undetermined"}` };
  }
  return { ...base, detail: r.complaint?.complaintFeedbackType ?? "complaint" };
}

const S = MessageDeliveryStatus;
// Statuses a new status may replace.
const REPLACES: Record<"DELIVERED" | "BOUNCED" | "COMPLAINED", MessageDeliveryStatus[]> = {
  DELIVERED: [S.SENT],
  BOUNCED: [S.SENT, S.DELIVERED],
  COMPLAINED: [S.SENT, S.DELIVERED, S.BOUNCED],
};

export async function applySesEvent(tp: TenantPrismaClient, ev: SesEvent): Promise<void> {
  const message = await tp.message.findFirst({
    where: { externalId: ev.messageId, channel: MessageChannel.EMAIL, direction: MessageDirection.OUTBOUND },
    select: { id: true, customerId: true },
  });
  if (!message) return;

  const status = ev.type === "Delivery" ? "DELIVERED" : ev.type === "Bounce" ? "BOUNCED" : "COMPLAINED";
  const now = new Date();
  await tp.message.updateMany({
    where: { id: message.id, OR: [{ deliveryStatus: null }, { deliveryStatus: { in: REPLACES[status] } }] },
    data: { deliveryStatus: S[status], deliveryUpdatedAt: now, ...(ev.detail ? { deliveryError: ev.detail } : {}) },
  });
  if (ev.type === "Delivery") return;

  // A hard bounce or a complaint means we must stop emailing this address until someone edits it.
  if ((ev.type === "Complaint" || ev.permanent) && message.customerId) {
    await tp.customer.updateMany({ where: { id: message.customerId, emailInvalidAt: null }, data: { emailInvalidAt: now } });
  }
  await evaluateEmailHealth(tp, now);
}

/**
 * Pauses the tenant's email when (a) the last 100+ sends are over the complaint (0.3%) or HARD bounce (5%) rate, or
 * (b) regardless of volume, 3+ complaints or 10+ hard bounces were recorded in the last 7 days.
 */
export async function evaluateEmailHealth(tp: TenantPrismaClient, now = new Date()): Promise<boolean> {
  const base = { channel: MessageChannel.EMAIL, direction: MessageDirection.OUTBOUND };
  const [sample, recent] = await Promise.all([
    tp.message.findMany({ where: base, orderBy: { createdAt: "desc" }, take: HEALTH.minSample, select: { deliveryStatus: true, deliveryError: true } }),
    tp.message.findMany({
      where: {
        ...base,
        deliveryStatus: { in: [S.BOUNCED, S.COMPLAINED] },
        deliveryUpdatedAt: { gte: new Date(now.getTime() - HEALTH.windowDays * 86_400_000) },
      },
      select: { deliveryStatus: true, deliveryError: true },
    }),
  ]);
  const pct = (n: number) => (n * 100).toFixed(1);
  let reason: string | null = null;

  const recentComplaints = recent.filter((m) => m.deliveryStatus === S.COMPLAINED).length;
  const recentHard = recent.filter(isHardBounce).length;
  if (recentComplaints >= HEALTH.maxComplaints) reason = `${recentComplaints} complaints in the last ${HEALTH.windowDays} days.`;
  else if (recentHard >= HEALTH.maxHardBounces) reason = `${recentHard} hard bounces in the last ${HEALTH.windowDays} days.`;
  else if (sample.length >= HEALTH.minSample) {
    const complaints = sample.filter((m) => m.deliveryStatus === S.COMPLAINED).length / sample.length;
    const hard = sample.filter(isHardBounce).length / sample.length;
    if (complaints > HEALTH.complaintRate) reason = `Complaint rate ${pct(complaints)}% over the last ${sample.length} emails (limit 0.3%).`;
    else if (hard > HEALTH.bounceRate) reason = `Hard bounce rate ${pct(hard)}% over the last ${sample.length} emails (limit 5%).`;
  }
  if (!reason) return false;

  const paused = await tp.businessSettings.updateMany({
    where: { emailPausedReason: null },
    data: { emailPausedReason: reason, emailPausedAt: now },
  });
  if (paused.count > 0) {
    await notifyAdmins(tp, {
      type: "INTEGRATION",
      title: "Email sending paused",
      body: `${reason} Customer emails are paused to protect your sender reputation. Check your customer email addresses, then resume email in Settings > Email.`,
    });
  }
  return true;
}
