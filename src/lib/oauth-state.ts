import { createHmac, randomBytes } from "crypto";
import { safeEqual } from "./crypto";

// Signed, expiring OAuth `state` (A5). GET /settings/ghl/callback is public —
// GHL redirects the browser there without our bearer token — so the tenant
// (and the redirect URI the code was issued for) must come from a state value
// only this server could have minted. Format: base64url(JSON payload) + "." +
// base64url(HMAC-SHA256(payload)). Keyed off ENCRYPTION_KEY so no new secret
// has to be provisioned.

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  tenantId: string;
  redirectUri: string;
  exp: number; // epoch ms
  nonce: string;
}

function key(): string {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) throw new Error("ENCRYPTION_KEY must be set to sign OAuth state");
  return `oauth-state:${k}`;
}

function sign(data: string): string {
  return createHmac("sha256", key()).update(data).digest("base64url");
}

export function signOAuthState(input: { tenantId: string; redirectUri: string }, now = Date.now()): string {
  const payload: OAuthStatePayload = {
    tenantId: input.tenantId,
    redirectUri: input.redirectUri,
    exp: now + OAUTH_STATE_TTL_MS,
    nonce: randomBytes(8).toString("hex"),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

export type OAuthStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyOAuthState(state: string, now = Date.now()): OAuthStateResult {
  const [data, sig, extra] = state.split(".");
  if (!data || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  if (!safeEqual(sig, sign(data))) return { ok: false, reason: "bad_signature" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.tenantId !== "string" || typeof payload.redirectUri !== "string" || typeof payload.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
