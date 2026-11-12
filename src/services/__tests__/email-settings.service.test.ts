import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTenantEmail = vi.fn();
vi.mock("../email.service", async () => {
  const actual = await vi.importActual<typeof import("../email.service")>("../email.service");
  return { ...actual, sendTenantEmail: (...a: unknown[]) => sendTenantEmail(...a), resolveTenantId: vi.fn().mockResolvedValue("ten1") };
});
const invalidate = vi.fn();
vi.mock("../settings.service", () => ({ invalidateCachedBusinessSettings: (...a: unknown[]) => invalidate(...a) }));
const signed = vi.fn();
vi.mock("../../lib/signed-read-url", () => ({ createSignedReadUrls: (...a: unknown[]) => signed(...a) }));
const uploadUrl = vi.fn();
vi.mock("../../lib/storage", async () => {
  const actual = await vi.importActual<typeof import("../../lib/storage")>("../../lib/storage");
  return { ...actual, createSignedUploadUrl: (...a: unknown[]) => uploadUrl(...a) };
});

import { createEmailSettingsService } from "../email-settings.service";

let row: Record<string, any>;
let tp: any;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.SES_REGION = "eu-west-2";
  process.env.SES_FROM_DOMAIN_ADDRESS = "notifications@mail.roundflow.ai";
  delete process.env.EMAIL_DISABLED;
  row = {
    businessName: "Sparkle", email: "owner@sparkle.co.uk", emailSenderName: null, emailReplyTo: null, emailSenderDomain: null, emailSenderLocalPart: null,
    emailDomainStatus: "NONE", emailDkimRecords: null, emailDomainVerifiedAt: null, emailEnabled: true, emailDailyLimit: null,
    emailPausedReason: null, emailPausedAt: null, logoPath: null, logoAltText: null, brandColour: null,
  };
  tp = {
    businessSettings: {
      findFirst: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return { count: 1 }; }),
    },
    message: {
      count: vi.fn().mockResolvedValue(3),
      findMany: vi.fn().mockResolvedValue([{ deliveryStatus: "DELIVERED" }, { deliveryStatus: "BOUNCED" }, { deliveryStatus: "COMPLAINED" }, { deliveryStatus: "SENT" }]),
    },
  };
  signed.mockResolvedValue(new Map([["ten1/branding/logo.png", "https://signed/logo.png"]]));
  sendTenantEmail.mockResolvedValue({ externalId: "ses-1", tier: 1, from: '"Sparkle" <notifications@mail.roundflow.ai>' });
  uploadUrl.mockResolvedValue({ signedUrl: "https://up", token: "tok", path: "ten1/branding/logo-1.png" });
});

const svc = () => createEmailSettingsService(tp);

describe("get", () => {
  it("returns identity, branding, health counters, sender preview and domain", async () => {
    const v = await svc().get();
    expect(v).toMatchObject({
      configured: true, enabled: true, paused: false, pausedReason: null, senderName: null, replyTo: null, dailyLimit: null, sentToday: 3,
      brandColour: null, logoUrl: null,
      sender: { tier: 1, from: '"Sparkle" <notifications@mail.roundflow.ai>', replyTo: "owner@sparkle.co.uk" },
      health: { sampleSize: 4, delivered: 1, bounced: 1, complaints: 1, bounceRate: 0.25, complaintRate: 0.25 },
      domain: { status: "NONE", tier: 1 },
    });
  });
  it("signs the logo, includes the brand colour check and paused state", async () => {
    Object.assign(row, { logoPath: "ten1/branding/logo.png", logoAltText: "Logo", brandColour: "#029BB6", emailPausedReason: "Too many bounces", emailPausedAt: new Date("2026-11-06") });
    const v = await svc().get();
    expect(v).toMatchObject({ logoUrl: "https://signed/logo.png", logoAltText: "Logo", paused: true, pausedReason: "Too many bounces" });
    expect(v.brandColourCheck).toMatchObject({ colour: "#029BB6", warning: { code: "LOW_CONTRAST_ON_WHITE" } });
  });
  it("a logo that cannot be signed is simply absent; no sample = zero rates; unconfigured SES is reported", async () => {
    Object.assign(row, { logoPath: "ten1/branding/logo.png" });
    signed.mockRejectedValue(new Error("down"));
    tp.message.findMany.mockResolvedValue([]);
    delete process.env.SES_REGION;
    const v = await svc().get();
    expect(v).toMatchObject({ logoUrl: null, configured: false, health: { sampleSize: 0, bounceRate: 0, complaintRate: 0 } });
    signed.mockResolvedValue(new Map());
    expect((await svc().get()).logoUrl).toBeNull();
  });
  it("works for a tenant without a settings row", async () => {
    tp.businessSettings.findFirst.mockResolvedValue(null);
    expect(await svc().get()).toMatchObject({ enabled: true, sender: { tier: 1 } });
  });
});

describe("update", () => {
  it("validates and stores identity fields, then returns the fresh view", async () => {
    const r = await svc().update({
      emailSenderName: " Sparkle Accounts ", emailReplyTo: "Accounts@Sparkle.co.uk", emailEnabled: false, emailDailyLimit: 250, logoAltText: "Sparkle logo",
    });
    expect(row).toMatchObject({ emailSenderName: "Sparkle Accounts", emailReplyTo: "accounts@sparkle.co.uk", emailEnabled: false, emailDailyLimit: 250, logoAltText: "Sparkle logo" });
    expect(r.view.senderName).toBe("Sparkle Accounts");
    expect(invalidate).toHaveBeenCalledWith(tp);
  });
  it("null clears the optional fields", async () => {
    Object.assign(row, { emailSenderName: "x", emailReplyTo: "a@b.co", emailDailyLimit: 5, brandColour: "#00758C", logoAltText: "x" });
    await svc().update({ emailSenderName: null, emailReplyTo: null, emailDailyLimit: null, brandColour: null, logoAltText: null });
    expect(row).toMatchObject({ emailSenderName: null, emailReplyTo: null, emailDailyLimit: null, brandColour: null, logoAltText: null });
  });
  it("rejects header-injection attempts and bad values with typed 400s, writing nothing", async () => {
    for (const [body, code] of [
      [{ emailSenderName: "Evil\r\nBcc: x@y.com" }, "INVALID_EMAIL_SENDER_NAME"],
      [{ emailSenderName: 'A "B"' }, "INVALID_EMAIL_SENDER_NAME"],
      [{ emailReplyTo: "a@b.com, c@d.com" }, "INVALID_EMAIL_ADDRESS"],
      [{ brandColour: "red" }, "INVALID_BRAND_COLOUR"],
      [{ brandColour: 5 }, "INVALID_BRAND_COLOUR"],
      [{ emailDailyLimit: 0 }, "INVALID_EMAIL_DAILY_LIMIT"],
      [{ emailDailyLimit: 1.5 }, "INVALID_EMAIL_DAILY_LIMIT"],
      [{ emailDailyLimit: 100001 }, "INVALID_EMAIL_DAILY_LIMIT"],
      [{ emailEnabled: "yes" }, "VALIDATION_FAILED"],
      [{ logoAltText: "x".repeat(126) }, "VALIDATION_FAILED"],
      [{ logoAltText: "a\nb" }, "VALIDATION_FAILED"],
      [{ emailPaused: "no" }, "VALIDATION_FAILED"],
      [{}, "VALIDATION_FAILED"],
      [{ nothingKnown: 1 }, "VALIDATION_FAILED"],
    ] as Array<[Record<string, unknown>, string]>) {
      await expect(svc().update(body)).rejects.toMatchObject({ statusCode: 400, code });
    }
    expect(tp.businessSettings.updateMany).not.toHaveBeenCalled();
  });
  it("brand colour: stored normalised; a low-contrast colour is saved with a warning and safe colours", async () => {
    const ok = await svc().update({ brandColour: "#00758c" });
    expect(row.brandColour).toBe("#00758C");
    expect(ok.brandColourCheck).toMatchObject({ warning: null, textColour: "#FFFFFF" });
    const low = await svc().update({ brandColour: "#029bb6" });
    expect(row.brandColour).toBe("#029BB6");
    expect(low.brandColourCheck?.warning).toMatchObject({ code: "LOW_CONTRAST_ON_WHITE", textColour: "#000000", safeAccentColour: expect.stringMatching(/^#[0-9A-F]{6}$/) });
  });
  it("an update without a brand colour returns no check", async () => {
    expect((await svc().update({ emailEnabled: true })).brandColourCheck).toBeNull();
  });
  it("emailPaused:false resumes (clears the reason); true pauses with a reason", async () => {
    row.emailPausedReason = "Bounce rate";
    await svc().update({ emailPaused: false });
    expect(row).toMatchObject({ emailPausedReason: null, emailPausedAt: null });
    await svc().update({ emailPaused: true });
    expect(row.emailPausedReason).toBe("Paused by an administrator.");
    expect(row.emailPausedAt).toBeInstanceOf(Date);
  });
  it("emailSenderLocalPart is validated and stored", async () => {
    await svc().update({ emailSenderLocalPart: "Billing" });
    expect(row.emailSenderLocalPart).toBe("billing");
    await svc().update({ emailSenderLocalPart: null });
    expect(row.emailSenderLocalPart).toBeNull();
    await expect(svc().update({ emailSenderLocalPart: "a b" })).rejects.toMatchObject({ code: "INVALID_EMAIL_LOCAL_PART" });
  });
});

describe("logo", () => {
  it("issues a signed upload URL under <tenantId>/branding/ for png/jpeg/webp only", async () => {
    const r = await svc().logoUploadUrl("image/png");
    expect(uploadUrl).toHaveBeenCalledWith(expect.stringMatching(/^ten1\/branding\/logo-\d+\.png$/));
    expect(r).toEqual({ signedUrl: "https://up", token: "tok", path: "ten1/branding/logo-1.png" });
    for (const bad of ["image/svg+xml", "image/heic", "text/html", 5]) {
      await expect(svc().logoUploadUrl(bad)).rejects.toMatchObject({ statusCode: 400, code: "INVALID_LOGO_TYPE" });
    }
  });
  it("attaches only a path inside this tenant's branding folder", async () => {
    const v = await svc().setLogo({ path: "ten1/branding/logo.png", altText: "Sparkle" });
    expect(row).toMatchObject({ logoPath: "ten1/branding/logo.png", logoAltText: "Sparkle" });
    expect(v.logoUrl).toBe("https://signed/logo.png");
    for (const bad of ["other/branding/logo.png", "ten1/visits/x.png", "ten1/branding/../x.png", "ten1/branding/logo.svg", "", 7]) {
      await expect(svc().setLogo({ path: bad as never })).rejects.toMatchObject({ statusCode: 400, code: "INVALID_LOGO_PATH" });
    }
    await svc().setLogo({ path: "ten1/branding/logo.png" });
    expect(row.logoAltText).toBe("Sparkle");
  });
  it("setLogo validates the alt text and clearLogo removes logo and alt text", async () => {
    await expect(svc().setLogo({ path: "ten1/branding/logo.png", altText: "a\nb" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    Object.assign(row, { logoPath: "ten1/branding/logo.png", logoAltText: "x" });
    const v = await svc().clearLogo();
    expect(row).toMatchObject({ logoPath: null, logoAltText: null });
    expect(v.logoUrl).toBeNull();
  });
});

describe("sendTest", () => {
  it("sends a branded test email to the given address", async () => {
    const r = await svc().sendTest("me@sparkle.co.uk");
    expect(sendTenantEmail).toHaveBeenCalledWith(tp, expect.objectContaining({ to: "me@sparkle.co.uk", transactional: true, messageId: expect.stringMatching(/^test-/), subject: expect.stringContaining("Test") }));
    expect(r).toEqual({ sent: true, from: '"Sparkle" <notifications@mail.roundflow.ai>', tier: 1 });
  });
  it("needs an address", async () => {
    await expect(svc().sendTest("")).rejects.toMatchObject({ statusCode: 400, code: "INVALID_EMAIL_ADDRESS" });
  });
});
