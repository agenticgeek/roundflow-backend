import { it, expect, vi } from "vitest";

// We test the path-building logic in isolation — the Supabase client call is
// the external boundary, so we mock it.
it("visit photo storage path includes tenantId, visitId and photo type", async () => {
  const { buildVisitPhotoPath } = await import("../storage.js");

  const path = buildVisitPhotoPath("tenant-abc", "visit-xyz", "BEFORE", "image/jpeg");

  expect(path).toMatch(/^tenant-abc\/visits\/visit-xyz\/before-/);
  expect(path).toMatch(/\.jpg$/);
});

it("buildVisitPhotoPath uses png extension for image/png", async () => {
  const { buildVisitPhotoPath } = await import("../storage.js");

  const path = buildVisitPhotoPath("t1", "v1", "AFTER", "image/png");

  expect(path).toMatch(/\.png$/);
});

it("buildVisitPhotoPath falls back to jpg for unknown mime type", async () => {
  const { buildVisitPhotoPath } = await import("../storage.js");

  const path = buildVisitPhotoPath("t1", "v1", "BEFORE", "image/tiff");

  expect(path).toMatch(/\.jpg$/);
});

it("getPublicUrl builds the correct Supabase storage public URL", async () => {
  process.env.SUPABASE_URL = "https://abc.supabase.co";
  process.env.VISIT_PHOTOS_BUCKET = "visit-photos";
  const { getPublicUrl } = await import("../storage.js");

  const url = getPublicUrl("t1/visits/v1/before-123.jpg");

  expect(url).toBe("https://abc.supabase.co/storage/v1/object/public/visit-photos/t1/visits/v1/before-123.jpg");
});

// ---------------------------------------------------------------------------
// MIME type validation
// ---------------------------------------------------------------------------

it("ALLOWED_PHOTO_MIME_TYPES includes jpeg, png, webp, heic", async () => {
  const { ALLOWED_PHOTO_MIME_TYPES } = await import("../storage.js");

  expect(ALLOWED_PHOTO_MIME_TYPES).toContain("image/jpeg");
  expect(ALLOWED_PHOTO_MIME_TYPES).toContain("image/png");
  expect(ALLOWED_PHOTO_MIME_TYPES).toContain("image/webp");
  expect(ALLOWED_PHOTO_MIME_TYPES).toContain("image/heic");
});

it("ALLOWED_PHOTO_MIME_TYPES does not include pdf or gif", async () => {
  const { ALLOWED_PHOTO_MIME_TYPES } = await import("../storage.js");

  expect(ALLOWED_PHOTO_MIME_TYPES).not.toContain("application/pdf");
  expect(ALLOWED_PHOTO_MIME_TYPES).not.toContain("image/gif");
});

// ---------------------------------------------------------------------------
// File size validation
// ---------------------------------------------------------------------------

it("MAX_PHOTO_BYTES is 10 MB", async () => {
  const { MAX_PHOTO_BYTES } = await import("../storage.js");

  expect(MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
});
