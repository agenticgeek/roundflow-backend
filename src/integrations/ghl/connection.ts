// GHL connection helpers used by the /settings/ghl/* routes (connect, status,
// test). Messaging/contact calls live in ./api.ts.

const GHL_API = "https://services.leadconnectorhq.com";

export type GhlLocationResult =
  | { ok: true; locationName: string | null }
  | { ok: false; status: number; message: string };

/** GET /locations/:id with the given token. Used to validate a private API key,
 *  for POST /settings/ghl/test and for the status card's location name.
 *  Never throws: network errors come back as { ok: false, status: 0 }. */
export async function fetchGhlLocation(token: string, locationId: string): Promise<GhlLocationResult> {
  let res: Response;
  try {
    res = await fetch(`${GHL_API}/locations/${encodeURIComponent(locationId)}`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28" },
    });
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: ghlErrorMessage(text) || `GHL responded ${res.status}` };
  }
  const body = (await res.json().catch(() => ({}))) as { location?: { name?: string } };
  return { ok: true, locationName: body.location?.name ?? null };
}

// GHL error bodies are usually JSON ({ message } or { error }); fall back to the raw text.
function ghlErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const msg = parsed.message ?? parsed.error;
    if (typeof msg === "string") return msg;
    if (Array.isArray(msg)) return msg.join(", ");
  } catch {
    // not JSON
  }
  return text;
}

/** The API-side OAuth redirect URI (GHL sends the browser here). */
export function ghlApiRedirectUri(): string {
  return `${process.env.PUBLIC_API_URL}/settings/ghl/callback`;
}

export function ghlWebhookUrl(tenantId: string, secret: string): string {
  return `${process.env.PUBLIC_API_URL}/webhooks/ghl?tenantId=${tenantId}&secret=${secret}`;
}

/** First configured web origin (FRONTEND_URL may be a comma-separated CORS list). */
export function frontendBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? "").split(",")[0].trim();
}

/** True when `uri` is on one of the configured web origins — the only
 *  redirect URIs authorize will sign into a state (no open redirect). */
export function isAllowedWebRedirect(uri: string): boolean {
  let origin: string;
  try {
    origin = new URL(uri).origin;
  } catch {
    return false;
  }
  return (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .some((o) => {
      try {
        return new URL(o).origin === origin;
      } catch {
        return false;
      }
    });
}
