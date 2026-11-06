import { AppError } from "../lib/app-error";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { isMailerConfigured, mailerConfig, sharedSendingDomain } from "../lib/mailer/config";
import { MailerError, type DkimRecord, type IdentityInfo, type IdentityStatus } from "../lib/mailer/ses";
import { validateLocalPart, validateSenderDomain } from "../lib/mailer/sender";
import { ChannelUnavailableError, getMailer, resolveTenantId } from "./email.service";
import { invalidateCachedBusinessSettings } from "./settings.service";

// Tier 2 (GHL-11): the tenant's own sending domain. Start creates an SES email identity (Easy DKIM) tagged with the
// tenant id and returns the 3 DKIM CNAME records; status polls SES; the nightly job re-checks. A tenant sends from
// its own address only while the status is VERIFIED, otherwise tier 1 (shared address, tenant name) is used.

export interface DomainView {
  domain: string | null;
  localPart: string | null;
  status: "NONE" | IdentityStatus;
  records: DkimRecord[];
  verifiedAt: Date | null;
  /** 1 = shared RoundFlow address, 2 = the tenant's verified domain. */
  tier: 1 | 2;
  /** The address customers see mail from right now. */
  sendingAddress: string | null;
}

interface DomainRow {
  emailSenderDomain: string | null;
  emailSenderLocalPart: string | null;
  emailDomainStatus: string;
  emailDkimRecords: unknown;
  emailDomainVerifiedAt: Date | null;
}

const select = {
  emailSenderDomain: true, emailSenderLocalPart: true, emailDomainStatus: true, emailDkimRecords: true, emailDomainVerifiedAt: true,
} as const;

export function domainView(row: DomainRow): DomainView {
  const verified = row.emailDomainStatus === "VERIFIED" && !!row.emailSenderDomain;
  return {
    domain: row.emailSenderDomain,
    localPart: row.emailSenderLocalPart,
    status: row.emailDomainStatus as DomainView["status"],
    records: Array.isArray(row.emailDkimRecords) ? (row.emailDkimRecords as DkimRecord[]) : [],
    verifiedAt: row.emailDomainVerifiedAt,
    tier: verified ? 2 : 1,
    sendingAddress: verified ? `${row.emailSenderLocalPart || "accounts"}@${row.emailSenderDomain}` : (mailerConfig().fromAddress ?? null),
  };
}

const EMPTY: DomainRow = { emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null };

function fail(err: unknown): never {
  if (err instanceof MailerError) {
    if (err.code === "NOT_CONFIGURED" || err.code === "EMAIL_DISABLED") {
      throw new ChannelUnavailableError("EMAIL_NOT_CONFIGURED", "Email sending is not set up on this server.", "EMAIL");
    }
    if (err.awsName === "AlreadyExistsException") {
      throw new AppError(409, "That domain is already registered by another business.", "EMAIL_DOMAIN_IN_USE");
    }
    throw new AppError(502, "Amazon SES could not complete the domain request. Try again shortly.", "EMAIL_DOMAIN_FAILED");
  }
  throw err;
}

export function createEmailDomainService(tp: TenantPrismaClient) {
  const read = async (): Promise<DomainRow> => (await tp.businessSettings.findFirst({ select })) ?? EMPTY;
  const write = async (data: Record<string, unknown>): Promise<void> => {
    await tp.businessSettings.updateMany({ data });
    invalidateCachedBusinessSettings(tp);
  };
  const applyIdentity = (identity: IdentityInfo, extra: Record<string, unknown> = {}) => ({
    emailDomainStatus: identity.status,
    emailDkimRecords: identity.records,
    emailDomainVerifiedAt: identity.status === "VERIFIED" ? new Date() : null,
    ...extra,
  });

  return {
    async start(input: { domain: unknown; localPart?: unknown }): Promise<DomainView> {
      const domain = validateSenderDomain(input.domain, sharedSendingDomain());
      const localPart = input.localPart === undefined || input.localPart === null ? null : validateLocalPart(input.localPart);
      if (!isMailerConfigured()) throw new ChannelUnavailableError("EMAIL_NOT_CONFIGURED", "Email sending is not set up on this server.", "EMAIL");

      const current = await read();
      try {
        if (current.emailSenderDomain && current.emailSenderDomain !== domain) await getMailer().deleteIdentity(current.emailSenderDomain);
        const identity = await getMailer().createIdentity(domain, { tenantId: await resolveTenantId(tp) });
        await write(applyIdentity(identity, { emailSenderDomain: domain, emailSenderLocalPart: localPart }));
      } catch (err) {
        return fail(err);
      }
      return domainView(await read());
    },

    async status(): Promise<DomainView> {
      const current = await read();
      if (!current.emailSenderDomain) return domainView(current);
      let identity: IdentityInfo | null;
      try {
        identity = await getMailer().getIdentity(current.emailSenderDomain);
      } catch (err) {
        return fail(err);
      }
      const next = identity ?? { status: "FAILED" as const, records: [] };
      if (next.status !== current.emailDomainStatus) {
        await write(applyIdentity(next, next.status === "VERIFIED" ? {} : { emailDomainVerifiedAt: null }));
      }
      return domainView(await read());
    },

    async remove(): Promise<DomainView> {
      const current = await read();
      if (!current.emailSenderDomain) return domainView(current);
      try {
        await getMailer().deleteIdentity(current.emailSenderDomain);
      } catch (err) {
        return fail(err);
      }
      await write({ emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null });
      return domainView(await read());
    },
  };
}
