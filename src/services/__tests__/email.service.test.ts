import { beforeEach, describe, expect, it, vi } from "vitest";

const { tenantFind, signed } = vi.hoisted(() => ({ tenantFind: vi.fn(), signed: vi.fn() }));
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findFirst: tenantFind } } }));
vi.mock("../../lib/tenant-prisma-manager", () => ({ getSchemaNameForClient: (c: { schema?: string }) => c.schema ?? "t_aaaaaaaaaaaaaaaaaaaa" }));
vi.mock("../../lib/signed-read-url", () => ({ createSignedReadUrls: signed }));

import {
  ChannelUnavailableError, getEmailAvailability, getMailer, resolveTenantId, sendTenantEmail, setMailer, startOfUtcDay, EMAIL_LOGO_TTL_SECONDS,
} from "../email.service";
import { MailerError } from "../../lib/mailer/ses";

const ENV_KEYS = ["SES_REGION", "SES_FROM_DOMAIN_ADDRESS", "EMAIL_DISABLED", "SES_CONFIGURATION_SET"];
const saved: Record<string, string | undefined> = {};

const settings = {
  businessName: "Sparkle Windows", email: "owner@sparkle.co.uk", phone: "0113", addressLine1: "1 High St", addressLine2: null, town: "Leeds", postcode: "LS1 1AA",
  vatRegistered: true, vatRegistration: "GB1", companyNumber: "0123", termsUrl: null, privacyUrl: "https://s.co/p", invoiceFooter: "Thanks",
  emailSenderName: null, emailReplyTo: null, emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE",
  emailEnabled: true, emailPausedReason: null, emailDailyLimit: null, brandColour: "#00758C", logoPath: null, logoAltText: null,
};

let tp: any;
let mailer: { send: ReturnType<typeof vi.fn> };
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.SES_REGION = "eu-west-2";
  process.env.SES_FROM_DOMAIN_ADDRESS = "notifications@mail.roundflow.ai";
  tenantFind.mockReset().mockResolvedValue({ id: "ten1" });
  signed.mockReset().mockResolvedValue(new Map([["ten1/branding/logo.png", "https://signed.example/logo.png"]]));
  tp = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ ...settings }) },
    message: { count: vi.fn().mockResolvedValue(0) },
  };
  mailer = { send: vi.fn().mockResolvedValue({ messageId: "ses-9" }) };
  setMailer(mailer as never);
  return () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } setMailer(null); };
});

describe("getMailer / setMailer", () => {
  it("lazily builds the SES mailer and can be overridden", () => {
    setMailer(null);
    expect(getMailer()).toBe(getMailer());
    setMailer(mailer as never);
    expect(getMailer()).toBe(mailer);
  });
});

describe("resolveTenantId", () => {
  it("looks the tenant up by schema once and caches it", async () => {
    expect(await resolveTenantId(tp)).toBe("ten1");
    expect(await resolveTenantId(tp)).toBe("ten1");
    expect(tenantFind).toHaveBeenCalledTimes(1);
  });
  it("throws when the tenant is unknown (and does not cache the miss)", async () => {
    tenantFind.mockResolvedValueOnce(null);
    await expect(resolveTenantId({ schema: "t_bbbbbbbbbbbbbbbbbbbb" } as never)).rejects.toThrow(/tenant/i);
  });
});

describe("getEmailAvailability", () => {
  it("available when SES is configured and the tenant has email on", async () => {
    expect(await getEmailAvailability(tp)).toEqual({ available: true });
  });
  it("not configured / EMAIL_DISABLED are platform-level reasons", async () => {
    delete process.env.SES_REGION;
    expect(await getEmailAvailability(tp)).toEqual({ available: false, reason: "EMAIL_NOT_CONFIGURED" });
    process.env.SES_REGION = "eu-west-2";
    process.env.EMAIL_DISABLED = "true";
    expect(await getEmailAvailability(tp)).toEqual({ available: false, reason: "EMAIL_NOT_CONFIGURED" });
    expect(tp.businessSettings.findFirst).not.toHaveBeenCalled();
  });
  it("tenant switch and automatic pause", async () => {
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, emailEnabled: false });
    expect(await getEmailAvailability(tp)).toEqual({ available: false, reason: "EMAIL_TURNED_OFF" });
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, emailPausedReason: "Complaint rate above 0.3%" });
    expect(await getEmailAvailability(tp)).toEqual({ available: false, reason: "EMAIL_PAUSED", detail: "Complaint rate above 0.3%" });
  });
  it("a tenant without a settings row counts as enabled", async () => {
    tp.businessSettings.findFirst.mockResolvedValue(null);
    expect(await getEmailAvailability(tp)).toEqual({ available: true });
  });
});

describe("sendTenantEmail", () => {
  const input = { to: "ann@example.com", subject: "Invoice INV-1", bodyText: "Hi Ann", transactional: true, messageId: "msg1" };

  it("sends as the tenant (tier 1), branded, tagged with tenantId and messageId", async () => {
    const r = await sendTenantEmail(tp, { ...input, cta: { label: "Pay", url: "https://pay.test/x" }, preheader: "pre" });
    expect(r).toEqual({ externalId: "ses-9", tier: 1, from: '"Sparkle Windows" <notifications@mail.roundflow.ai>' });
    const sent = mailer.send.mock.calls[0][0];
    expect(sent).toMatchObject({
      from: '"Sparkle Windows" <notifications@mail.roundflow.ai>', replyTo: "owner@sparkle.co.uk", to: "ann@example.com", subject: "Invoice INV-1",
      tags: { tenantId: "ten1", messageId: "msg1" },
    });
    expect(sent.html).toContain("Sparkle Windows");
    expect(sent.html).toContain("1 High St, Leeds, LS1 1AA");
    expect(sent.html).toContain("GB1");
    expect(sent.html).toContain("Thanks");
    expect(sent.html).toContain("https://s.co/p");
    expect(sent.text).toContain("Pay: https://pay.test/x");
    expect(signed).not.toHaveBeenCalled();
  });
  it("defaults the subject to the business name", async () => {
    await sendTenantEmail(tp, { to: "a@b.co", bodyText: "x", transactional: true, messageId: "m" });
    expect(mailer.send.mock.calls[0][0].subject).toBe("Message from Sparkle Windows");
    tp.businessSettings.findFirst.mockResolvedValue(null);
    await sendTenantEmail(tp, { to: "a@b.co", bodyText: "x", transactional: true, messageId: "m" });
    expect(mailer.send.mock.calls[1][0].subject).toBe("Message from your service provider");
  });
  it("tier 2 once the tenant's own domain is VERIFIED", async () => {
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, emailSenderDomain: "sparkle.co.uk", emailDomainStatus: "VERIFIED", emailSenderName: "Sparkle Accounts" });
    const r = await sendTenantEmail(tp, input);
    expect(r.tier).toBe(2);
    expect(mailer.send.mock.calls[0][0].from).toBe('"Sparkle Accounts" <accounts@sparkle.co.uk>');
  });
  it("embeds the signed logo with alt text", async () => {
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, logoPath: "ten1/branding/logo.png", logoAltText: "Sparkle sparkle" });
    await sendTenantEmail(tp, input);
    expect(signed).toHaveBeenCalledWith(["ten1/branding/logo.png"], EMAIL_LOGO_TTL_SECONDS);
    const html = mailer.send.mock.calls[0][0].html as string;
    expect(html).toContain("https://signed.example/logo.png");
    expect(html).toContain('alt="Sparkle sparkle"');
  });
  it("falls back to a default alt text and survives a logo signing failure", async () => {
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, logoPath: "ten1/branding/logo.png" });
    await sendTenantEmail(tp, input);
    expect(mailer.send.mock.calls[0][0].html).toContain('alt="Sparkle Windows logo"');
    signed.mockRejectedValueOnce(new Error("storage down"));
    await sendTenantEmail(tp, input);
    expect(mailer.send.mock.calls[1][0].html).not.toContain("<img");
    signed.mockResolvedValueOnce(new Map([["ten1/branding/logo.png", null]]));
    await sendTenantEmail(tp, input);
    expect(mailer.send.mock.calls[2][0].html).not.toContain("<img");
  });
  it("passes attachments and non-transactional flag through", async () => {
    const att = [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x") }];
    await sendTenantEmail(tp, { ...input, attachments: att, transactional: false });
    const sent = mailer.send.mock.calls[0][0];
    expect(sent.attachments).toBe(att);
    expect(sent.text).toMatch(/opt out/i);
  });
  it("refuses when unavailable, with a typed CHANNEL_UNAVAILABLE", async () => {
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, emailPausedReason: "Bounce rate above 5%" });
    const err = await sendTenantEmail(tp, input).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelUnavailableError);
    expect(err).toMatchObject({ statusCode: 409, code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_PAUSED" });
    expect(mailer.send).not.toHaveBeenCalled();
  });
  it("enforces the daily cap (default 1000, per-tenant override)", async () => {
    tp.message.count.mockResolvedValue(1000);
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_DAILY_LIMIT" });
    tp.message.count.mockResolvedValue(5);
    tp.businessSettings.findFirst.mockResolvedValue({ ...settings, emailDailyLimit: 5 });
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ reason: "EMAIL_DAILY_LIMIT" });
    tp.message.count.mockResolvedValue(4);
    await expect(sendTenantEmail(tp, input)).resolves.toMatchObject({ externalId: "ses-9" });
    const where = tp.message.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ channel: "EMAIL", direction: "OUTBOUND" });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });
  it("maps provider failures to typed errors", async () => {
    mailer.send.mockRejectedValueOnce(new MailerError("NOT_CONFIGURED", "x"));
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE", reason: "EMAIL_NOT_CONFIGURED" });
    mailer.send.mockRejectedValueOnce(new MailerError("EMAIL_DISABLED", "x"));
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE" });
    mailer.send.mockRejectedValueOnce(new MailerError("PROVIDER_UNAVAILABLE", "x", true));
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_SEND_FAILED" });
    mailer.send.mockRejectedValueOnce(new MailerError("PROVIDER_REJECTED", "x"));
    await expect(sendTenantEmail(tp, input)).rejects.toMatchObject({ statusCode: 502, code: "EMAIL_SEND_FAILED" });
    mailer.send.mockRejectedValueOnce(new Error("unexpected"));
    await expect(sendTenantEmail(tp, input)).rejects.toThrow("unexpected");
  });
  it("a tenant with no settings row still sends (neutral sender)", async () => {
    tp.businessSettings.findFirst.mockResolvedValue(null);
    await sendTenantEmail(tp, input);
    expect(mailer.send.mock.calls[0][0].from).toBe("notifications@mail.roundflow.ai");
  });
});

describe("startOfUtcDay", () => {
  it("truncates to 00:00 UTC", () => {
    expect(startOfUtcDay(new Date("2026-11-06T15:30:00Z")).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });
});
