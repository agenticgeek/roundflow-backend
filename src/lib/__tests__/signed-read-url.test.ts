import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignedReadUrls, toObjectPath, READ_URL_TTL_SECONDS } from "../signed-read-url";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("SUPABASE_URL", "https://sb.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  vi.stubEnv("VISIT_PHOTOS_BUCKET", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("toObjectPath maps paths and storage URLs of the bucket, rejects others", () => {
  vi.stubEnv("VISIT_PHOTOS_BUCKET", "visit-photos");
  expect(toObjectPath("/t1/visits/v1/before-1.jpg")).toBe("t1/visits/v1/before-1.jpg");
  expect(toObjectPath("https://sb.test/storage/v1/object/public/visit-photos/t1/a%20b.jpg")).toBe("t1/a b.jpg");
  expect(toObjectPath("https://sb.test/storage/v1/object/sign/visit-photos/t1/x.jpg?token=abc")).toBe("t1/x.jpg");
  expect(toObjectPath("https://sb.test/storage/v1/object/visit-photos/t1/y.jpg")).toBe("t1/y.jpg");
  expect(toObjectPath("https://sb.test/storage/v1/object/public/other-bucket/t1/x.jpg")).toBeNull();
  expect(toObjectPath("https://sb.test/storage/v1/object/public/visit-photos")).toBeNull();
  expect(toObjectPath("https://cdn.example.com/x.jpg")).toBeNull();
});

it("createSignedReadUrls signs bucket objects in one batch and passes external URLs through", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [
      { path: "t1/a.jpg", signedURL: "/object/sign/visit-photos/t1/a.jpg?token=1", error: null },
      { path: "t1/b.jpg", signedURL: null, error: "Not found" },
    ],
  });

  const result = await createSignedReadUrls(["t1/a.jpg", "/t1/a.jpg", "t1/b.jpg", "https://cdn.example.com/x.jpg"]);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://sb.test/storage/v1/object/sign/visit-photos");
  expect(JSON.parse(init.body)).toEqual({ expiresIn: READ_URL_TTL_SECONDS, paths: ["t1/a.jpg", "t1/b.jpg"] });
  expect(result.get("t1/a.jpg")).toBe("https://sb.test/storage/v1/object/sign/visit-photos/t1/a.jpg?token=1");
  expect(result.get("/t1/a.jpg")).toBe("https://sb.test/storage/v1/object/sign/visit-photos/t1/a.jpg?token=1");
  expect(result.get("t1/b.jpg")).toBeNull();
  expect(result.get("https://cdn.example.com/x.jpg")).toBe("https://cdn.example.com/x.jpg");
});

it("createSignedReadUrls skips Storage when nothing needs signing", async () => {
  const result = await createSignedReadUrls([]);
  expect(result.size).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("createSignedReadUrls throws when Storage env vars are missing", async () => {
  vi.stubEnv("SUPABASE_URL", "");
  await expect(createSignedReadUrls(["t1/a.jpg"], 60)).rejects.toThrow("SUPABASE_URL");
});

it("createSignedReadUrls throws on a Storage error response", async () => {
  fetchMock.mockResolvedValue({ ok: false, text: async () => "boom" });
  await expect(createSignedReadUrls(["t1/a.jpg"])).rejects.toThrow("Storage error: boom");
});

import { createSignedThumbnailUrls, createSignedPhotoUrls, THUMBNAIL_WIDTH, THUMBNAIL_QUALITY } from "../signed-read-url";

it("createSignedThumbnailUrls signs a transformed url per bucket object and skips external urls", async () => {
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({ signedURL: `/render/image/sign/visit-photos/${url.split("/visit-photos/")[1]}?token=t` }),
  }));
  const stored = ["t1/a b.jpg", ...Array.from({ length: 9 }, (_, i) => `t1/${i}.jpg`), "https://cdn.example.com/x.jpg"];

  const result = await createSignedThumbnailUrls(stored);

  expect(fetchMock).toHaveBeenCalledTimes(10);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://sb.test/storage/v1/object/sign/visit-photos/t1/a%20b.jpg");
  expect(JSON.parse(init.body)).toEqual({
    expiresIn: READ_URL_TTL_SECONDS,
    transform: { width: THUMBNAIL_WIDTH, quality: THUMBNAIL_QUALITY, resize: "contain" },
  });
  expect(result.get("t1/a b.jpg")).toBe("https://sb.test/storage/v1/render/image/sign/visit-photos/t1/a%20b.jpg?token=t");
  expect(result.get("t1/8.jpg")).toContain("/render/image/sign/");
  expect(result.has("https://cdn.example.com/x.jpg")).toBe(false);
});

it("createSignedThumbnailUrls gives up after the first failure (transforms unavailable)", async () => {
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
  expect((await createSignedThumbnailUrls(["t1/a.jpg", "t1/b.jpg"])).size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("createSignedThumbnailUrls tolerates per-object failures, network errors and empty input", async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ signedURL: "/render/image/sign/visit-photos/a?token=1" }) })
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ signedURL: null }) });
  const result = await createSignedThumbnailUrls(["t1/a.jpg", "t1/b.jpg", "t1/c.jpg"]);
  expect([...result.keys()]).toEqual(["t1/a.jpg"]);

  fetchMock.mockClear();
  expect((await createSignedThumbnailUrls(["https://cdn.example.com/x.jpg"])).size).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  vi.stubEnv("SUPABASE_URL", "");
  expect((await createSignedThumbnailUrls(["t1/a.jpg"])).size).toBe(0);
});

it("createSignedPhotoUrls falls back to the full url when no thumbnail could be signed", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/object/sign/visit-photos")) {
      return {
        ok: true,
        json: async () => [
          { path: "t1/a.jpg", signedURL: "/object/sign/visit-photos/t1/a.jpg?token=1", error: null },
          { path: "t1/b.jpg", signedURL: "/object/sign/visit-photos/t1/b.jpg?token=2", error: null },
        ],
      };
    }
    if (url.includes("/t1/a.jpg")) return { ok: true, json: async () => ({ signedURL: "/render/image/sign/visit-photos/t1/a.jpg?token=3" }) };
    return { ok: false, json: async () => ({}) };
  });

  const result = await createSignedPhotoUrls(["t1/a.jpg", "t1/b.jpg", "https://cdn.example.com/x.jpg"]);

  expect(result.get("t1/a.jpg")).toEqual({
    url: "https://sb.test/storage/v1/object/sign/visit-photos/t1/a.jpg?token=1",
    thumbnailUrl: "https://sb.test/storage/v1/render/image/sign/visit-photos/t1/a.jpg?token=3",
  });
  const b = "https://sb.test/storage/v1/object/sign/visit-photos/t1/b.jpg?token=2";
  expect(result.get("t1/b.jpg")).toEqual({ url: b, thumbnailUrl: b });
  expect(result.get("https://cdn.example.com/x.jpg")).toEqual({
    url: "https://cdn.example.com/x.jpg",
    thumbnailUrl: "https://cdn.example.com/x.jpg",
  });
});
