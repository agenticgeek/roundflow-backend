import { beforeEach, describe, expect, it, vi } from "vitest";

const mailer = { createIdentity: vi.fn(), getIdentity: vi.fn(), deleteIdentity: vi.fn() };
vi.mock("../email.service", async () => {
  const actual = await vi.importActual<typeof import("../email.service")>("../email.service");
  return { ...actual, getMailer: () => mailer, resolveTenantId: vi.fn().mockResolvedValue("ten1") };
});
const invalidate = vi.fn();
vi.mock("../settings.service", () => ({ invalidateCachedBusinessSettings: (...a: unknown[]) => invalidate(...a) }));

import { createEmailDomainService, domainView } from "../email-domain.service";
import { MailerError } from "../../lib/mailer/ses";

const RECORDS = [{ type: "CNAME", name: "a._domainkey.acme.co.uk", value: "a.dkim.amazonses.com" }];
let row: Record<string, unknown>;
let tp: any;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SES_REGION = "eu-west-2";
  process.env.SES_FROM_DOMAIN_ADDRESS = "notifications@mail.roundflow.ai";
  delete process.env.EMAIL_DISABLED;
  row = { emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null };
  tp = {
    businessSettings: {
      findFirst: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return { count: 1 }; }),
    },
  };
  mailer.createIdentity.mockResolvedValue({ status: "PENDING", records: RECORDS });
  mailer.getIdentity.mockResolvedValue({ status: "PENDING", records: RECORDS });
  mailer.deleteIdentity.mockResolvedValue(undefined);
});

const svc = () => createEmailDomainService(tp);

describe("domainView", () => {
  it("tier 1 until VERIFIED; tier 2 sends from <localPart|accounts>@domain", () => {
    expect(domainView({ emailSenderDomain: "acme.co.uk", emailSenderLocalPart: null, emailDomainStatus: "PENDING", emailDkimRecords: RECORDS, emailDomainVerifiedAt: null })).toMatchObject({
      domain: "acme.co.uk", status: "PENDING", tier: 1, sendingAddress: "notifications@mail.roundflow.ai", records: RECORDS,
    });
    const v = domainView({ emailSenderDomain: "acme.co.uk", emailSenderLocalPart: "billing", emailDomainStatus: "VERIFIED", emailDkimRecords: RECORDS, emailDomainVerifiedAt: new Date("2026-11-06") });
    expect(v).toMatchObject({ tier: 2, sendingAddress: "billing@acme.co.uk", verifiedAt: new Date("2026-11-06") });
    expect(domainView({ emailSenderDomain: "acme.co.uk", emailSenderLocalPart: null, emailDomainStatus: "VERIFIED", emailDkimRecords: null, emailDomainVerifiedAt: null }).sendingAddress).toBe("accounts@acme.co.uk");
    expect(domainView({ emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null })).toMatchObject({ domain: null, status: "NONE", records: [], tier: 1 });
  });
});

describe("start", () => {
  it("creates the SES identity with Easy DKIM and stores PENDING + the 3 records", async () => {
    const v = await svc().start({ domain: " Acme.co.uk " , localPart: "Billing" });
    expect(mailer.createIdentity).toHaveBeenCalledWith("acme.co.uk", { tenantId: "ten1" });
    expect(row).toMatchObject({ emailSenderDomain: "acme.co.uk", emailSenderLocalPart: "billing", emailDomainStatus: "PENDING", emailDkimRecords: RECORDS, emailDomainVerifiedAt: null });
    expect(v).toMatchObject({ status: "PENDING", records: RECORDS, tier: 1 });
    expect(invalidate).toHaveBeenCalledWith(tp);
  });
  it("an already-verified identity is VERIFIED straight away", async () => {
    mailer.createIdentity.mockResolvedValue({ status: "VERIFIED", records: RECORDS });
    const v = await svc().start({ domain: "acme.co.uk" });
    expect(v).toMatchObject({ status: "VERIFIED", tier: 2 });
    expect(row.emailDomainVerifiedAt).toBeInstanceOf(Date);
    expect(row.emailSenderLocalPart).toBeNull();
  });
  it("refuses free-mail and reserved domains before calling SES", async () => {
    await expect(svc().start({ domain: "gmail.com" })).rejects.toMatchObject({ statusCode: 400, code: "FREE_MAIL_DOMAIN" });
    await expect(svc().start({ domain: "mail.roundflow.ai" })).rejects.toMatchObject({ code: "RESERVED_EMAIL_DOMAIN" });
    await expect(svc().start({ domain: "acme.co.uk", localPart: "a b" })).rejects.toMatchObject({ code: "INVALID_EMAIL_LOCAL_PART" });
    expect(mailer.createIdentity).not.toHaveBeenCalled();
  });
  it("409 when SES is not configured", async () => {
    delete process.env.SES_REGION;
    await expect(svc().start({ domain: "acme.co.uk" })).rejects.toMatchObject({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_NOT_CONFIGURED" });
  });
  it("replacing a different domain removes the old identity first", async () => {
    row.emailSenderDomain = "old.co.uk";
    await svc().start({ domain: "acme.co.uk" });
    expect(mailer.deleteIdentity).toHaveBeenCalledWith("old.co.uk");
    row.emailSenderDomain = "acme.co.uk";
    mailer.deleteIdentity.mockClear();
    await svc().start({ domain: "acme.co.uk" });
    expect(mailer.deleteIdentity).not.toHaveBeenCalled();
  });
  it("maps a domain registered by someone else to 409 and other SES failures to 502", async () => {
    mailer.createIdentity.mockRejectedValueOnce(new MailerError("PROVIDER_REJECTED", "x", false, "AlreadyExistsException"));
    await expect(svc().start({ domain: "acme.co.uk" })).rejects.toMatchObject({ statusCode: 409, code: "EMAIL_DOMAIN_IN_USE" });
    mailer.createIdentity.mockRejectedValueOnce(new MailerError("PROVIDER_UNAVAILABLE", "x", true));
    await expect(svc().start({ domain: "acme.co.uk" })).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_DOMAIN_FAILED" });
    mailer.createIdentity.mockRejectedValueOnce(new Error("unexpected"));
    await expect(svc().start({ domain: "acme.co.uk" })).rejects.toThrow("unexpected");
    expect(row.emailSenderDomain).toBeNull();
  });
});

describe("status", () => {
  beforeEach(() => Object.assign(row, { emailSenderDomain: "acme.co.uk", emailDomainStatus: "PENDING", emailDkimRecords: RECORDS }));

  it("polls SES and moves PENDING -> VERIFIED (stamping the time) and back", async () => {
    mailer.getIdentity.mockResolvedValue({ status: "VERIFIED", records: RECORDS });
    expect(await svc().status()).toMatchObject({ status: "VERIFIED", tier: 2 });
    expect(row.emailDomainVerifiedAt).toBeInstanceOf(Date);
    mailer.getIdentity.mockResolvedValue({ status: "FAILED", records: RECORDS });
    expect(await svc().status()).toMatchObject({ status: "FAILED", tier: 1 });
    expect(row.emailDomainVerifiedAt).toBeNull();
  });
  it("does not write when nothing changed", async () => {
    await svc().status();
    expect(tp.businessSettings.updateMany).not.toHaveBeenCalled();
  });
  it("an identity that vanished in SES is FAILED with no records", async () => {
    mailer.getIdentity.mockResolvedValue(null);
    expect(await svc().status()).toMatchObject({ status: "FAILED", records: [] });
  });
  it("with no domain it just reports NONE without calling SES", async () => {
    Object.assign(row, { emailSenderDomain: null, emailDomainStatus: "NONE" });
    expect(await svc().status()).toMatchObject({ domain: null, status: "NONE" });
    expect(mailer.getIdentity).not.toHaveBeenCalled();
  });
  it("SES not configured / switched off while polling is the typed CHANNEL_UNAVAILABLE", async () => {
    mailer.getIdentity.mockRejectedValue(new MailerError("NOT_CONFIGURED", "x"));
    await expect(svc().status()).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_NOT_CONFIGURED" });
    mailer.getIdentity.mockRejectedValue(new MailerError("EMAIL_DISABLED", "x"));
    await expect(svc().status()).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE" });
  });
  it("a provider failure is 502 EMAIL_DOMAIN_FAILED and keeps the stored state", async () => {
    mailer.getIdentity.mockRejectedValue(new MailerError("PROVIDER_UNAVAILABLE", "x", true));
    await expect(svc().status()).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_DOMAIN_FAILED" });
  });
  it("a missing settings row reports NONE", async () => {
    tp.businessSettings.findFirst.mockResolvedValue(null);
    expect(await svc().status()).toMatchObject({ domain: null, status: "NONE" });
  });
});

describe("remove", () => {
  it("deletes the SES identity and resets the tenant to tier 1", async () => {
    Object.assign(row, { emailSenderDomain: "acme.co.uk", emailSenderLocalPart: "billing", emailDomainStatus: "VERIFIED", emailDkimRecords: RECORDS, emailDomainVerifiedAt: new Date() });
    const v = await svc().remove();
    expect(mailer.deleteIdentity).toHaveBeenCalledWith("acme.co.uk");
    expect(row).toMatchObject({ emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE", emailDomainVerifiedAt: null });
    expect(v).toMatchObject({ domain: null, tier: 1 });
    expect(invalidate).toHaveBeenCalled();
  });
  it("is a no-op without a domain, and surfaces SES failures", async () => {
    await svc().remove();
    expect(mailer.deleteIdentity).not.toHaveBeenCalled();
    Object.assign(row, { emailSenderDomain: "acme.co.uk", emailDomainStatus: "PENDING" });
    mailer.deleteIdentity.mockRejectedValue(new MailerError("PROVIDER_REJECTED", "x"));
    await expect(svc().remove()).rejects.toMatchObject({ code: "EMAIL_DOMAIN_FAILED" });
    expect(row.emailSenderDomain).toBe("acme.co.uk");
  });
});
