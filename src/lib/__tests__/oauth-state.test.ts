import { it, expect, afterEach } from "vitest";
import { signOAuthState, verifyOAuthState, OAUTH_STATE_TTL_MS } from "../oauth-state";

const input = { tenantId: "tenant-1", redirectUri: "https://api.test/settings/ghl/callback" };
const originalKey = process.env.ENCRYPTION_KEY;
afterEach(() => {
  process.env.ENCRYPTION_KEY = originalKey;
});

it("round-trips a signed state", () => {
  const now = 1_000_000;
  const result = verifyOAuthState(signOAuthState(input, now), now + 1000);
  expect(result).toMatchObject({ ok: true, payload: { ...input, exp: now + OAUTH_STATE_TTL_MS } });
});

it("rejects an expired state", () => {
  const state = signOAuthState(input, 0);
  expect(verifyOAuthState(state, OAUTH_STATE_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
});

it("rejects a tampered payload or signature", () => {
  const state = signOAuthState(input);
  const [data, sig] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ ...input, tenantId: "tenant-2", exp: Date.now() + 1e6, nonce: "x" })).toString("base64url");
  expect(verifyOAuthState(`${forged}.${sig}`)).toEqual({ ok: false, reason: "bad_signature" });
  expect(verifyOAuthState(`${data}.AAAA${sig.slice(4)}`)).toEqual({ ok: false, reason: "bad_signature" });
});

it("rejects malformed states", () => {
  expect(verifyOAuthState("nodot")).toEqual({ ok: false, reason: "malformed" });
  expect(verifyOAuthState("a.b.c")).toEqual({ ok: false, reason: "malformed" });
  expect(verifyOAuthState(".sig")).toEqual({ ok: false, reason: "malformed" });
});

it("rejects a correctly signed payload that isn't valid JSON or lacks fields", async () => {
  const { createHmac } = await import("crypto");
  const sign = (data: string) =>
    createHmac("sha256", `oauth-state:${process.env.ENCRYPTION_KEY}`).update(data).digest("base64url");
  const notJson = Buffer.from("not json").toString("base64url");
  expect(verifyOAuthState(`${notJson}.${sign(notJson)}`)).toEqual({ ok: false, reason: "malformed" });
  const missing = Buffer.from(JSON.stringify({ tenantId: "t" })).toString("base64url");
  expect(verifyOAuthState(`${missing}.${sign(missing)}`)).toEqual({ ok: false, reason: "malformed" });
});

it("throws when ENCRYPTION_KEY is unset", () => {
  delete process.env.ENCRYPTION_KEY;
  expect(() => signOAuthState(input)).toThrow("ENCRYPTION_KEY");
});
