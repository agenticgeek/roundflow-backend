import { AppError } from "./app-error";

// BE-01: the one place that says which actions are ADMIN-only. Everything else behind requireBusinessAccess()
// stays ADMIN or MANAGER. Decision (Wave 2B-1): a MANAGER cannot
//   - invite or promote ADMINs (POST /invites with role ADMIN; there is no other role-change endpoint),
//   - connect or disconnect Stripe / GoCardless / GoHighLevel,
//   - change payment, bank or VAT settings,
//   - delete technicians,
//   - view or replay the integration dead-letter queue (/integrations/outbox),
//   - use Flo AI (/flo/*).
// Failures are 403 with code ADMIN_ONLY. The role matrix test (src/__tests__/role-matrix.test.ts) enforces this
// against the OpenAPI route table.

/** [METHOD, full path with :params] — enforced by `enforceAdminOnlyRoutes()` on the settings, setup and integrations routers. */
export const ADMIN_ONLY_ROUTES: ReadonlyArray<readonly [string, string]> = [
  // Wave 2B-2: setup wizard business profile (bank/VAT) and payment steps.
  ["POST", "/setup/step/1"],
  ["POST", "/setup/step/2"],
  ["PATCH", "/settings/payment"],
  ["POST", "/settings/payment/gocardless/connect"],
  ["POST", "/settings/payment/gocardless/disconnect"],
  ["PATCH", "/settings/payment/gocardless/webhook-secret"],
  ["GET", "/settings/stripe/authorize"],
  ["GET", "/settings/stripe/callback"],
  ["POST", "/settings/stripe/disconnect"],
  ["GET", "/settings/ghl/authorize"],
  ["POST", "/settings/ghl/test"],
  ["POST", "/settings/ghl/connect-private"],
  ["POST", "/settings/ghl/disconnect"],
  ["DELETE", "/settings/technicians/:id"],
  // Wave 2B-2: sender identity, branding, sending domain and test email (GET /settings/email stays ADMIN or MANAGER).
  ["PATCH", "/settings/email"],
  ["POST", "/settings/email/test"],
  ["GET", "/settings/email/domain"],
  ["POST", "/settings/email/domain"],
  ["DELETE", "/settings/email/domain"],
  ["POST", "/settings/email/logo/upload-url"],
  ["PUT", "/settings/email/logo"],
  ["DELETE", "/settings/email/logo"],
  ["GET", "/integrations/outbox"],
  ["POST", "/integrations/outbox/:id/replay"],
  // Flo AI (2026-11): admin-only assistant (plan D3). Enforced by enforceAdminOnlyRoutes() on the flo router.
  ["GET", "/flo/status"],
  ["GET", "/flo/suggestions"],
  ["POST", "/flo/chat"],
  ["GET", "/flo/conversations"],
  ["GET", "/flo/conversations/:id"],
  ["DELETE", "/flo/conversations/:id"],
];

/** PATCH /settings/business-profile fields a MANAGER may not touch (bank and VAT). */
export const ADMIN_ONLY_BUSINESS_PROFILE_FIELDS = ["bankDetails", "vatRegistered", "vatRegistration", "vatRate"] as const;

const ADMIN_ONLY_PATTERNS = ADMIN_ONLY_ROUTES.map(([method, path]) => ({
  method,
  pattern: new RegExp("^" + path.replace(/:[A-Za-z]+/g, "[^/]+") + "/?$"),
}));

export function isAdminOnlyRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return ADMIN_ONLY_PATTERNS.some((r) => r.method === m && r.pattern.test(path));
}

const ADMIN_ONLY_MESSAGE = "This action requires an administrator.";

export function adminOnlyError(message = ADMIN_ONLY_MESSAGE): AppError {
  return new AppError(403, message, "ADMIN_ONLY");
}

/** Throws 403 ADMIN_ONLY unless the caller is an ADMIN. */
export function assertAdmin(profile: { role: string } | undefined): void {
  if (profile?.role !== "ADMIN") throw adminOnlyError();
}

/** A MANAGER may invite MANAGER and TECHNICIAN, never ADMIN. */
export function assertCanInviteRole(profile: { role: string }, targetRole: string): void {
  if (targetRole === "ADMIN") assertAdmin(profile);
}

/** A MANAGER may edit the business profile except bank and VAT fields. `body` is the raw request body. */
export function assertAdminForBusinessProfileFields(profile: { role: string }, body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const touched = ADMIN_ONLY_BUSINESS_PROFILE_FIELDS.some((f) => f in body);
  if (touched) assertAdmin(profile);
}
