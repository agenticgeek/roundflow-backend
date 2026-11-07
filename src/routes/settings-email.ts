import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { enforceAdminOnlyRoutes } from "../middleware/requireAdmin";
import { asObject, h } from "../lib/http";
import { createEmailSettingsService } from "../services/email-settings.service";
import { createMessageService } from "../services/message.service";

// Mounted at /settings/email (before /settings). Reading is ADMIN or MANAGER; every change (identity, domain,
// logo, test email) is ADMIN only (src/lib/permissions.ts ADMIN_ONLY_ROUTES).
export const settingsEmailRouter = Router();
settingsEmailRouter.use(requireAuth);
settingsEmailRouter.use(requireTenantAccess);
settingsEmailRouter.use(requireBusinessAccess());
settingsEmailRouter.use(enforceAdminOnlyRoutes());

const svc = (req: Request) => createEmailSettingsService(req.tenantPrisma!);
const channels = (req: Request) => createMessageService(req.tenantPrisma!).capabilities();

// GET /settings/email -> identity, branding, health counters, sender preview, domain, channels
settingsEmailRouter.get("/", h(async (req, res) => {
  res.json({ ...(await svc(req).get()), channels: await channels(req) });
}));

// PATCH /settings/email -> same view + brandColourCheck + warning (null unless the colour fails 4.5:1 as text on white)
settingsEmailRouter.patch("/", h(async (req, res) => {
  const { view, brandColourCheck } = await svc(req).update(asObject(req.body));
  res.json({ ...view, channels: await channels(req), brandColourCheck, warning: brandColourCheck?.warning ?? null });
}));

// POST /settings/email/test -> sends a branded test email to the signed-in admin
settingsEmailRouter.post("/test", h(async (req, res) => {
  res.json(await svc(req).sendTest(req.user!.email));
}));

// Tier 2: tenant-owned sending domain
settingsEmailRouter.get("/domain", h(async (req, res) => { res.json(await svc(req).domain.status()); }));
settingsEmailRouter.post("/domain", h(async (req, res) => {
  const b = asObject(req.body);
  res.json(await svc(req).domain.start({ domain: b.domain, localPart: b.localPart }));
}));
settingsEmailRouter.delete("/domain", h(async (req, res) => { res.json(await svc(req).domain.remove()); }));

// Logo: signed upload -> attach path -> signed read url (in GET /settings/email as logoUrl)
settingsEmailRouter.post("/logo/upload-url", h(async (req, res) => {
  res.json(await svc(req).logoUploadUrl(asObject(req.body).mimeType));
}));
settingsEmailRouter.put("/logo", h(async (req, res) => {
  const b = asObject(req.body);
  res.json(await svc(req).setLogo({ path: b.path, altText: b.altText }));
}));
settingsEmailRouter.delete("/logo", h(async (req, res) => { res.json(await svc(req).clearLogo()); }));
