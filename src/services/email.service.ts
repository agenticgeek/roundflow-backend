import { prisma } from "../lib/prisma";
import { AppError } from "../lib/app-error";
import { getSchemaNameForClient, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { createSignedReadUrls } from "../lib/signed-read-url";
import { isMailerConfigured, mailerConfig } from "../lib/mailer/config";
import { MailerError, SesMailer, type EmailAttachment, type MailProvider } from "../lib/mailer/ses";
import { resolveSender } from "../lib/mailer/sender";
import { renderEmail, type EmailBrand } from "../lib/mailer/template";
import { MessageChannel, MessageDirection } from "../generated/tenant-client";

// Native tenant email (GHL-01/03/10/11). Everything that sends customer email goes through sendTenantEmail():
// it checks the channel is available, enforces the tenant's daily cap, resolves the tenant's sender identity
// (tier 1 shared address, tier 2 verified own domain), wraps the body in the tenant's branding and hands it to the
// provider with tenantId + messageId tags so SES events can be mapped back.

export const EMAIL_LOGO_TTL_SECONDS = 90 * 24 * 3600;
export const DEFAULT_DAILY_LIMIT = 1000;

export type ChannelUnavailableReason =
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_TURNED_OFF"
  | "EMAIL_PAUSED"
  | "EMAIL_DAILY_LIMIT"
  | "EMAIL_ADDRESS_INVALID"
  | "NO_AVAILABLE_CHANNEL"
  | "GHL_NOT_CONNECTED";

/** 409 CHANNEL_UNAVAILABLE + `reason`: the channel cannot be used right now (never GHL_NOT_CONNECTED for email). */
export class ChannelUnavailableError extends AppError {
  constructor(public readonly reason: ChannelUnavailableReason, message: string, public readonly channel?: string) {
    super(409, message, "CHANNEL_UNAVAILABLE");
    this.name = "ChannelUnavailableError";
  }
}

let provider: MailProvider | null = null;
export function getMailer(): MailProvider {
  return (provider ??= new SesMailer(mailerConfig()));
}
/** Test seam: inject a fake provider (null resets to the real SES one). */
export function setMailer(p: MailProvider | null): void {
  provider = p;
}

const tenantIds = new Map<string, string>();
/** Public Tenant id of a tenant client (schema name -> id, cached). Used for SES tags and storage paths. */
export async function resolveTenantId(tp: TenantPrismaClient): Promise<string> {
  const schemaName = getSchemaNameForClient(tp) as string;
  const cached = tenantIds.get(schemaName);
  if (cached) return cached;
  const tenant = await prisma.tenant.findFirst({ where: { schemaName }, select: { id: true } });
  if (!tenant) throw new AppError(500, "Tenant not found for this client");
  tenantIds.set(schemaName, tenant.id);
  return tenant.id;
}

export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type EmailAvailability = { available: true } | { available: false; reason: ChannelUnavailableReason; detail?: string };

const MESSAGES: Partial<Record<ChannelUnavailableReason, string>> = {
  EMAIL_NOT_CONFIGURED: "Email sending is not set up on this server.",
  EMAIL_TURNED_OFF: "Email is switched off for this business (Settings > Email).",
  EMAIL_PAUSED: "Email sending is paused for this business.",
  EMAIL_DAILY_LIMIT: "The daily email limit for this business has been reached.",
};

export function unavailableError(a: Extract<EmailAvailability, { available: false }>): ChannelUnavailableError {
  return new ChannelUnavailableError(a.reason, `${MESSAGES[a.reason]}${a.detail ? ` ${a.detail}` : ""}`, "EMAIL");
}

const settingsSelect = {
  businessName: true, email: true, phone: true, addressLine1: true, addressLine2: true, town: true, postcode: true,
  vatRegistered: true, vatRegistration: true, companyNumber: true, termsUrl: true, privacyUrl: true, invoiceFooter: true,
  emailSenderName: true, emailReplyTo: true, emailSenderDomain: true, emailSenderLocalPart: true, emailDomainStatus: true,
  emailEnabled: true, emailPausedReason: true, emailDailyLimit: true, brandColour: true, logoPath: true, logoAltText: true,
} as const;

export async function getEmailAvailability(tp: TenantPrismaClient): Promise<EmailAvailability> {
  if (!isMailerConfigured()) return { available: false, reason: "EMAIL_NOT_CONFIGURED" };
  const s = await tp.businessSettings.findFirst({ select: { emailEnabled: true, emailPausedReason: true } });
  if (s && !s.emailEnabled) return { available: false, reason: "EMAIL_TURNED_OFF" };
  if (s?.emailPausedReason) return { available: false, reason: "EMAIL_PAUSED", detail: s.emailPausedReason };
  return { available: true };
}

async function signedLogo(path: string): Promise<string | null> {
  try {
    return (await createSignedReadUrls([path], EMAIL_LOGO_TTL_SECONDS)).get(path) ?? null;
  } catch (err) {
    console.error("[email] could not sign the tenant logo, sending without it:", (err as Error).message);
    return null;
  }
}

export interface TenantEmailInput {
  to: string;
  /** Defaults to "Message from <business name>". */
  subject?: string;
  bodyText: string;
  preheader?: string;
  cta?: { label: string; url: string };
  summary?: Array<[string, string]>;
  attachments?: EmailAttachment[];
  /** false = reminders/notices (adds the opt-out note). */
  transactional: boolean;
  /** Our Message row id (pre-generated), attached as an SES tag. */
  messageId: string;
}

export async function sendTenantEmail(
  tp: TenantPrismaClient,
  input: TenantEmailInput
): Promise<{ externalId: string; tier: 1 | 2; from: string }> {
  const availability = await getEmailAvailability(tp);
  if (!availability.available) throw unavailableError(availability);

  const s = await tp.businessSettings.findFirst({ select: settingsSelect });
  const limit = s?.emailDailyLimit ?? DEFAULT_DAILY_LIMIT;
  const sentToday = await tp.message.count({
    where: { channel: MessageChannel.EMAIL, direction: MessageDirection.OUTBOUND, createdAt: { gte: startOfUtcDay() } },
  });
  if (sentToday >= limit) throw unavailableError({ available: false, reason: "EMAIL_DAILY_LIMIT" });

  const tenantId = await resolveTenantId(tp);
  const sharedFrom = mailerConfig().fromAddress as string;
  const sender = resolveSender(
    {
      businessName: s?.businessName ?? null, email: s?.email ?? null, emailSenderName: s?.emailSenderName ?? null,
      emailReplyTo: s?.emailReplyTo ?? null, emailSenderDomain: s?.emailSenderDomain ?? null,
      emailSenderLocalPart: s?.emailSenderLocalPart ?? null, emailDomainStatus: s?.emailDomainStatus ?? "NONE",
    },
    sharedFrom
  );

  const logoUrl = s?.logoPath ? await signedLogo(s.logoPath) : null;
  const brand: EmailBrand = {
    businessName: s?.businessName ?? "",
    brandColour: s?.brandColour,
    logoUrl,
    logoAlt: s?.logoAltText || `${s?.businessName ?? ""} logo`.trim(),
    addressLines: [s?.addressLine1, s?.addressLine2, s?.town, s?.postcode].filter((x): x is string => !!x),
    phone: s?.phone,
    email: s?.email,
    vatRegistration: s?.vatRegistered ? s.vatRegistration : null,
    companyNumber: s?.companyNumber,
    termsUrl: s?.termsUrl,
    privacyUrl: s?.privacyUrl,
    footerText: s?.invoiceFooter,
  };
  const subject = input.subject ?? `Message from ${s?.businessName || "your service provider"}`;
  const { html, text } = renderEmail({
    subject, preheader: input.preheader, bodyText: input.bodyText, brand, cta: input.cta,
    summary: input.summary, transactional: input.transactional,
  });

  try {
    const { messageId } = await getMailer().send({
      from: sender.from, replyTo: sender.replyTo, to: input.to, subject, html, text,
      attachments: input.attachments, tags: { tenantId, messageId: input.messageId },
    });
    return { externalId: messageId, tier: sender.tier, from: sender.from };
  } catch (err) {
    if (!(err instanceof MailerError)) throw err;
    if (err.code === "NOT_CONFIGURED" || err.code === "EMAIL_DISABLED") throw unavailableError({ available: false, reason: "EMAIL_NOT_CONFIGURED" });
    throw new AppError(502, "The email provider could not send the message. Try again shortly.", "EMAIL_SEND_FAILED");
  }
}
