import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { email: "admin@sparkle.co.uk" }; next(); },
}));
vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "p1", tenantId: "ten1", role: req.headers["x-role"] ?? "ADMIN" };
    req.tenantPrisma = { tp: true };
    next();
  },
}));

const settings = { get: vi.fn(), update: vi.fn(), logoUploadUrl: vi.fn(), setLogo: vi.fn(), clearLogo: vi.fn(), sendTest: vi.fn(), domain: { start: vi.fn(), status: vi.fn(), remove: vi.fn() } };
vi.mock("../../services/email-settings.service", () => ({ createEmailSettingsService: () => settings }));
const capabilities = vi.fn();
vi.mock("../../services/message.service", () => ({ createMessageService: () => ({ capabilities }) }));

import { settingsEmailRouter } from "../settings-email";
import { errorHandler } from "../../lib/error-handler";

const app = express();
app.use(express.json());
app.use("/settings/email", settingsEmailRouter);
app.use(errorHandler);

const CHANNELS = { email: true, sms: false, whatsapp: false, calls: true };
beforeEach(() => {
  vi.clearAllMocks();
  capabilities.mockResolvedValue(CHANNELS);
  settings.get.mockResolvedValue({ enabled: true });
});

describe("GET /settings/email", () => {
  it("is readable by a MANAGER and includes the channel capabilities", async () => {
    const res = await request(app).get("/settings/email").set("x-role", "MANAGER");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, channels: CHANNELS });
  });
});

describe("ADMIN-only routes", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["patch", "/settings/email", { emailEnabled: true }],
    ["post", "/settings/email/test"],
    ["get", "/settings/email/domain"],
    ["post", "/settings/email/domain", { domain: "a.co.uk" }],
    ["delete", "/settings/email/domain"],
    ["post", "/settings/email/logo/upload-url", { mimeType: "image/png" }],
    ["put", "/settings/email/logo", { path: "x" }],
    ["delete", "/settings/email/logo"],
  ];
  it.each(routes)("%s %s is 403 ADMIN_ONLY for a MANAGER and never reaches the service", async (method, path, body) => {
    const res = await (request(app) as any)[method](path).set("x-role", "MANAGER").send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ADMIN_ONLY");
    expect(settings.update).not.toHaveBeenCalled();
    expect(settings.domain.start).not.toHaveBeenCalled();
  });
});

describe("as ADMIN", () => {
  it("PATCH returns the view, the colour check and a flat warning", async () => {
    const warning = { code: "LOW_CONTRAST_ON_WHITE", message: "m", textColour: "#000000", safeAccentColour: "#00758C" };
    settings.update.mockResolvedValue({ view: { enabled: false }, brandColourCheck: { colour: "#029BB6", warning } });
    const res = await request(app).patch("/settings/email").send({ brandColour: "#029BB6" });
    expect(settings.update).toHaveBeenCalledWith({ brandColour: "#029BB6" });
    expect(res.body).toEqual({ enabled: false, channels: CHANNELS, brandColourCheck: { colour: "#029BB6", warning }, warning });
  });
  it("PATCH without a colour check has a null warning; a non-object body is 400", async () => {
    settings.update.mockResolvedValue({ view: { enabled: true }, brandColourCheck: null });
    expect((await request(app).patch("/settings/email").send({ emailEnabled: true })).body.warning).toBeNull();
    expect((await request(app).patch("/settings/email").send([1])).status).toBe(400);
  });
  it("POST /test sends to the signed-in admin's own address", async () => {
    settings.sendTest.mockResolvedValue({ sent: true, from: "f", tier: 1 });
    const res = await request(app).post("/settings/email/test");
    expect(settings.sendTest).toHaveBeenCalledWith("admin@sparkle.co.uk");
    expect(res.body).toEqual({ sent: true, from: "f", tier: 1 });
  });
  it("domain start / status / remove", async () => {
    settings.domain.start.mockResolvedValue({ status: "PENDING" });
    settings.domain.status.mockResolvedValue({ status: "VERIFIED" });
    settings.domain.remove.mockResolvedValue({ status: "NONE" });
    expect((await request(app).post("/settings/email/domain").send({ domain: "a.co.uk", localPart: "billing" })).body).toEqual({ status: "PENDING" });
    expect(settings.domain.start).toHaveBeenCalledWith({ domain: "a.co.uk", localPart: "billing" });
    expect((await request(app).get("/settings/email/domain")).body).toEqual({ status: "VERIFIED" });
    expect((await request(app).delete("/settings/email/domain")).body).toEqual({ status: "NONE" });
  });
  it("logo: upload url, attach, remove", async () => {
    settings.logoUploadUrl.mockResolvedValue({ signedUrl: "u", token: "t", path: "p" });
    settings.setLogo.mockResolvedValue({ logoPath: "p" });
    settings.clearLogo.mockResolvedValue({ logoPath: null });
    expect((await request(app).post("/settings/email/logo/upload-url").send({ mimeType: "image/png" })).body).toEqual({ signedUrl: "u", token: "t", path: "p" });
    expect(settings.logoUploadUrl).toHaveBeenCalledWith("image/png");
    expect((await request(app).put("/settings/email/logo").send({ path: "p", altText: "Logo" })).body).toEqual({ logoPath: "p" });
    expect(settings.setLogo).toHaveBeenCalledWith({ path: "p", altText: "Logo" });
    expect((await request(app).delete("/settings/email/logo")).body).toEqual({ logoPath: null });
  });
});
