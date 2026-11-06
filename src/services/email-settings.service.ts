import { AppError, ValidationError } from "../lib/app-error";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { isMailerConfigured, mailerConfig } from "../lib/mailer/config";
import { checkBrandColour, isHexColour, type BrandColourCheck } from "../lib/mailer/contrast";
import { resolveSender, validateEmailAddress, validateLocalPart, validateSenderName } from "../lib/mailer/sender";
import { createSignedReadUrls } from "../lib/signed-read-url";
import { buildBrandingLogoPath, createSignedUploadUrl, LOGO_MIME_TYPES } from "../lib/storage";
import { MessageChannel, MessageDirection } from "../generated/tenant-client";
import { HEALTH } from "./email-events.service";
import { createEmailDomainService, domainView } from "./email-domain.service";
import { resolveTenantId, sendTenantEmail, startOfUtcDay } from "./email.service";
import { invalidateCachedBusinessSettings } from "./settings.service";

// Settings > Email and branding (GHL-10/11): sender identity, reply-to, on/off, daily cap, brand colour, logo, the
// health counters and the current sender preview. Domain verification lives in email-domain.service.ts.

const select = {
  businessName: true, email: true, emailSenderName: true, emailReplyTo: true, emailSenderDomain: true, emailSenderLocalPart: true,
  emailDomainStatus: true, emailDkimRecords: true, emailDomainVerifiedAt: true, emailEnabled: true, emailDailyLimit: true,
  emailPausedReason: true, emailPausedAt: true, logoPath: true, logoAltText: true, brandColour: true,
} as const;

const invalid = (path: string, message: string, code = "VALIDATION_FAILED") => new ValidationError(message, [{ path, code, message }], code);

const MAX_ALT = 125;

export function createEmailSettingsService(tp: TenantPrismaClient) {
  const read = () => tp.businessSettings.findFirst({ select });

  const signedLogo = async (path: string | null | undefined): Promise<string | null> => {
    if (!path) return null;
    try {
      return (await createSignedReadUrls([path])).get(path) ?? null;
    } catch {
      return null;
    }
  };

  const get = async () => {
    const [s, sentToday, sample] = await Promise.all([
      read(),
      tp.message.count({ where: { channel: MessageChannel.EMAIL, direction: MessageDirection.OUTBOUND, createdAt: { gte: startOfUtcDay() } } }),
      tp.message.findMany({
        where: { channel: MessageChannel.EMAIL, direction: MessageDirection.OUTBOUND },
        orderBy: { createdAt: "desc" },
        take: HEALTH.minSample,
        select: { deliveryStatus: true },
      }),
    ]);
    const count = (st: string) => sample.filter((m) => m.deliveryStatus === st).length;
    const n = sample.length;
    const from = mailerConfig().fromAddress;
    const sender = from
      ? resolveSender(
          {
            businessName: s?.businessName ?? null, email: s?.email ?? null, emailSenderName: s?.emailSenderName ?? null,
            emailReplyTo: s?.emailReplyTo ?? null, emailSenderDomain: s?.emailSenderDomain ?? null,
            emailSenderLocalPart: s?.emailSenderLocalPart ?? null, emailDomainStatus: s?.emailDomainStatus ?? "NONE",
          },
          from
        )
      : null;
    return {
      configured: isMailerConfigured(),
      enabled: s?.emailEnabled ?? true,
      paused: !!s?.emailPausedReason,
      pausedReason: s?.emailPausedReason ?? null,
      pausedAt: s?.emailPausedAt ?? null,
      senderName: s?.emailSenderName ?? null,
      replyTo: s?.emailReplyTo ?? null,
      dailyLimit: s?.emailDailyLimit ?? null,
      sentToday,
      brandColour: s?.brandColour ?? null,
      brandColourCheck: s?.brandColour ? checkBrandColour(s.brandColour) : null,
      logoPath: s?.logoPath ?? null,
      logoUrl: await signedLogo(s?.logoPath),
      logoAltText: s?.logoAltText ?? null,
      sender,
      health: {
        sampleSize: n,
        delivered: count("DELIVERED"),
        bounced: count("BOUNCED"),
        complaints: count("COMPLAINED"),
        bounceRate: n ? count("BOUNCED") / n : 0,
        complaintRate: n ? count("COMPLAINED") / n : 0,
      },
      domain: domainView(
        s ?? { emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null }
      ),
    };
  };

  const save = async (data: Record<string, unknown>) => {
    await tp.businessSettings.updateMany({ data });
    invalidateCachedBusinessSettings(tp);
  };

  const parseAlt = (v: unknown): string | null => {
    if (v === null) return null;
// eslint-disable-next-line no-control-regex -- intentionally rejects control characters (header injection)
    if (typeof v !== "string" || v.length > MAX_ALT || /[\u0000-\u001f\u007f]/.test(v)) {
      throw invalid("logoAltText", `logoAltText must be plain text of at most ${MAX_ALT} characters`);
    }
    return v.trim();
  };

  return {
    get,

    async update(body: Record<string, unknown>): Promise<{ view: Awaited<ReturnType<typeof get>>; brandColourCheck: BrandColourCheck | null }> {
      const data: Record<string, unknown> = {};
      let brandColourCheck: BrandColourCheck | null = null;

      if ("emailSenderName" in body) data.emailSenderName = body.emailSenderName === null ? null : validateSenderName(body.emailSenderName);
      if ("emailReplyTo" in body) data.emailReplyTo = body.emailReplyTo === null ? null : validateEmailAddress(body.emailReplyTo, "emailReplyTo");
      if ("emailSenderLocalPart" in body) data.emailSenderLocalPart = body.emailSenderLocalPart === null ? null : validateLocalPart(body.emailSenderLocalPart);
      if ("emailEnabled" in body) {
        if (typeof body.emailEnabled !== "boolean") throw invalid("emailEnabled", "emailEnabled must be true or false");
        data.emailEnabled = body.emailEnabled;
      }
      if ("emailDailyLimit" in body) {
        const v = body.emailDailyLimit;
        if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100_000)) {
          throw invalid("emailDailyLimit", "emailDailyLimit must be a whole number from 1 to 100000, or null", "INVALID_EMAIL_DAILY_LIMIT");
        }
        data.emailDailyLimit = v;
      }
      if ("brandColour" in body) {
        if (body.brandColour === null) data.brandColour = null;
        else if (!isHexColour(body.brandColour)) throw invalid("brandColour", "brandColour must be a #RRGGBB colour", "INVALID_BRAND_COLOUR");
        else {
          brandColourCheck = checkBrandColour(body.brandColour);
          data.brandColour = brandColourCheck.colour;
        }
      }
      if ("logoAltText" in body) data.logoAltText = parseAlt(body.logoAltText);
      if ("emailPaused" in body) {
        if (typeof body.emailPaused !== "boolean") throw invalid("emailPaused", "emailPaused must be true or false");
        data.emailPausedReason = body.emailPaused ? "Paused by an administrator." : null;
        data.emailPausedAt = body.emailPaused ? new Date() : null;
      }
      if (Object.keys(data).length === 0) throw invalid("body", "Nothing to update");

      await save(data);
      return { view: await get(), brandColourCheck };
    },

    async logoUploadUrl(mimeType: unknown) {
      if (typeof mimeType !== "string" || !(LOGO_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw new AppError(400, `Logo must be one of: ${LOGO_MIME_TYPES.join(", ")}`, "INVALID_LOGO_TYPE");
      }
      return createSignedUploadUrl(buildBrandingLogoPath(await resolveTenantId(tp), mimeType));
    },

    async setLogo(input: { path: unknown; altText?: unknown }) {
      const prefix = `${await resolveTenantId(tp)}/branding/`;
      const path = input.path;
      if (typeof path !== "string" || !path.startsWith(prefix) || path.includes("..") || !/\.(png|jpe?g|webp)$/.test(path)) {
        throw new AppError(400, "path must be an uploaded logo inside your branding folder", "INVALID_LOGO_PATH");
      }
      const data: Record<string, unknown> = { logoPath: path };
      if (input.altText !== undefined) data.logoAltText = parseAlt(input.altText);
      await save(data);
      return get();
    },

    async clearLogo() {
      await save({ logoPath: null, logoAltText: null });
      return get();
    },

    async sendTest(to: string) {
      const address = validateEmailAddress(to, "to");
      const sent = await sendTenantEmail(tp, {
        to: address,
        subject: "Test email from your business settings",
        bodyText: "This is a test email.\n\nIf you can read this, customers will see emails from your business in the same way.",
        transactional: true,
        messageId: `test-${Date.now()}`,
      });
      return { sent: true as const, from: sent.from, tier: sent.tier };
    },
    domain: createEmailDomainService(tp),
  };
}
