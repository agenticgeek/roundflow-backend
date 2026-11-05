import { it, expect, vi, beforeEach } from "vitest";

const createSignedReadUrls = vi.fn();
vi.mock("../../lib/signed-read-url", async (orig) => {
  const actual = await orig<typeof import("../../lib/signed-read-url")>();
  return { ...actual, createSignedReadUrls: (...a: unknown[]) => createSignedReadUrls(...a) };
});

import { signTenantMedia, signAvatar, signChatRows, signPhotos } from "../media-urls";

// Echo signer: "<value>?sig".
beforeEach(() => {
  createSignedReadUrls.mockReset();
  createSignedReadUrls.mockImplementation(async (values: string[]) => new Map(values.map((v) => [v, `${v}?sig`])));
});

it("signTenantMedia signs own-tenant paths, nulls other tenants, passes external urls to the signer, skips empties", async () => {
  const out = await signTenantMedia("t1", ["t1/a.jpg", "t2/b.jpg", "https://cdn.example.com/x.jpg", null, undefined, ""]);
  expect(createSignedReadUrls).toHaveBeenCalledWith(["t1/a.jpg", "https://cdn.example.com/x.jpg"]);
  expect(out.get("t1/a.jpg")).toBe("t1/a.jpg?sig");
  expect(out.get("t2/b.jpg")).toBeNull();
  expect(out.get("https://cdn.example.com/x.jpg")).toBe("https://cdn.example.com/x.jpg?sig");
});

it("signTenantMedia makes no Storage call when nothing needs signing", async () => {
  const out = await signTenantMedia("t1", ["t2/b.jpg", null]);
  expect(createSignedReadUrls).not.toHaveBeenCalled();
  expect(out.get("t2/b.jpg")).toBeNull();
});

it("signTenantMedia degrades to null when Storage fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  createSignedReadUrls.mockRejectedValue(new Error("down"));
  const out = await signTenantMedia("t1", ["t1/a.jpg"]);
  expect(out.get("t1/a.jpg")).toBeNull();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("signAvatar signs the stored avatar path, null when unset", async () => {
  expect(await signAvatar("t1", "t1/avatars/p.jpg")).toBe("t1/avatars/p.jpg?sig");
  expect(await signAvatar("t1", null)).toBeNull();
});

it("signChatRows adds index-aligned photoSignedUrls", async () => {
  const rows = await signChatRows("t1", [
    { id: "m1", photoUrls: ["t1/chat/a.jpg", "t2/chat/b.jpg", ""] },
    { id: "m2", photoUrls: [] },
  ]);
  expect(rows[0].photoSignedUrls).toEqual(["t1/chat/a.jpg?sig", null, null]);
  expect(rows[1].photoSignedUrls).toEqual([]);
  expect(rows[0].id).toBe("m1");
});

it("signPhotos adds signedUrl and keeps the stored url", async () => {
  const photos = await signPhotos("t1", [{ id: "p1", url: "t1/visits/v1/before-1.jpg" }, { id: "p2", url: "" }]);
  expect(photos).toEqual([
    { id: "p1", url: "t1/visits/v1/before-1.jpg", signedUrl: "t1/visits/v1/before-1.jpg?sig" },
    { id: "p2", url: "", signedUrl: null },
  ]);
});
