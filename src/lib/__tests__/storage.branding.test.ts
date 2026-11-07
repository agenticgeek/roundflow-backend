import { describe, expect, it } from "vitest";
import { buildBrandingLogoPath, LOGO_MIME_TYPES } from "../storage";

describe("buildBrandingLogoPath", () => {
  it("puts the logo under <tenantId>/branding/ with the right extension", () => {
    expect(buildBrandingLogoPath("ten1", "image/webp")).toMatch(/^ten1\/branding\/logo-\d+\.webp$/);
    expect(buildBrandingLogoPath("ten1", "image/jpeg")).toMatch(/\.jpg$/);
    expect(buildBrandingLogoPath("ten1", "application/x-unknown")).toMatch(/\.png$/);
    expect(LOGO_MIME_TYPES).not.toContain("image/svg+xml");
  });
});
