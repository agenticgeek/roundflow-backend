import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_BUSINESS_PROFILE_FIELDS,
  ADMIN_ONLY_ROUTES,
  assertAdmin,
  assertCanInviteRole,
  assertAdminForBusinessProfileFields,
  isAdminOnlyRoute,
} from "../permissions";

describe("ADMIN_ONLY_ROUTES (BE-01)", () => {
  it("lists provider connect/disconnect, payment rules and technician delete in one place", () => {
    const keys = ADMIN_ONLY_ROUTES.map(([m, p]) => `${m} ${p}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "POST /setup/step/1",
        "POST /setup/step/2",
        "PATCH /settings/payment",
        "POST /settings/payment/gocardless/connect",
        "POST /settings/payment/gocardless/disconnect",
        "PATCH /settings/payment/gocardless/webhook-secret",
        "GET /settings/stripe/authorize",
        "GET /settings/stripe/callback",
        "POST /settings/stripe/disconnect",
        "GET /settings/ghl/authorize",
        "POST /settings/ghl/connect-private",
        "POST /settings/ghl/disconnect",
        "DELETE /settings/technicians/:id",
        "GET /integrations/outbox",
        "POST /integrations/outbox/:id/replay",
      ])
    );
  });

  it("isAdminOnlyRoute matches method + path (params, trailing slash, query ignored)", () => {
    expect(isAdminOnlyRoute("PATCH", "/settings/payment")).toBe(true);
    expect(isAdminOnlyRoute("PATCH", "/settings/payment/")).toBe(true);
    expect(isAdminOnlyRoute("DELETE", "/settings/technicians/abc123")).toBe(true);
    expect(isAdminOnlyRoute("patch", "/settings/payment")).toBe(true);
    expect(isAdminOnlyRoute("GET", "/settings/payment")).toBe(false);
    expect(isAdminOnlyRoute("PATCH", "/settings/payment/other")).toBe(false);
    expect(isAdminOnlyRoute("DELETE", "/settings/technicians")).toBe(false);
    expect(isAdminOnlyRoute("PATCH", "/settings/technicians/abc")).toBe(false);
  });
});

describe("assertAdmin", () => {
  it("passes ADMIN and throws 403 ADMIN_ONLY for everyone else", () => {
    expect(() => assertAdmin({ role: "ADMIN" })).not.toThrow();
    for (const role of ["MANAGER", "TECHNICIAN"] as const) {
      try {
        assertAdmin({ role });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toMatchObject({ statusCode: 403, code: "ADMIN_ONLY" });
      }
    }
    expect(() => assertAdmin(undefined)).toThrow(/administrator/);
  });
});

describe("assertCanInviteRole", () => {
  it("a MANAGER cannot invite an ADMIN, but can invite MANAGER and TECHNICIAN", () => {
    expect(() => assertCanInviteRole({ role: "MANAGER" }, "ADMIN")).toThrow(expect.objectContaining({ statusCode: 403, code: "ADMIN_ONLY" }));
    expect(() => assertCanInviteRole({ role: "MANAGER" }, "MANAGER")).not.toThrow();
    expect(() => assertCanInviteRole({ role: "MANAGER" }, "TECHNICIAN")).not.toThrow();
    expect(() => assertCanInviteRole({ role: "ADMIN" }, "ADMIN")).not.toThrow();
  });
});

describe("assertAdminForBusinessProfileFields", () => {
  it("bank and VAT fields are admin-only; other profile fields are not", () => {
    expect(ADMIN_ONLY_BUSINESS_PROFILE_FIELDS).toEqual(["bankDetails", "vatRegistered", "vatRegistration", "vatRate"]);
    expect(() => assertAdminForBusinessProfileFields({ role: "MANAGER" }, { businessName: "x", phone: "1" })).not.toThrow();
    for (const f of ADMIN_ONLY_BUSINESS_PROFILE_FIELDS) {
      expect(() => assertAdminForBusinessProfileFields({ role: "MANAGER" }, { [f]: null })).toThrow(
        expect.objectContaining({ code: "ADMIN_ONLY" })
      );
      expect(() => assertAdminForBusinessProfileFields({ role: "ADMIN" }, { [f]: null })).not.toThrow();
    }
  });

  it("ignores a non-object body (the validator rejects it later)", () => {
    expect(() => assertAdminForBusinessProfileFields({ role: "MANAGER" }, null)).not.toThrow();
    expect(() => assertAdminForBusinessProfileFields({ role: "MANAGER" }, "x")).not.toThrow();
  });
});
