const GHL_AUTH_URL   = "https://marketplace.gohighlevel.com/oauth/chooselocation";
const GHL_TOKEN_URL  = "https://services.leadconnectorhq.com/oauth/token";

export const GHL_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "conversations.readonly",
  "conversations.write",
  "conversations/message.readonly",
  "conversations/message.write",
  "locations.readonly",
].join(" ");

export function buildGhlAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri:  redirectUri,
    client_id:     process.env.GHL_CLIENT_ID!,
    scope:         GHL_SCOPES,
    state,
  });
  return `${GHL_AUTH_URL}?${params}`;
}

export interface GhlTokenResponse {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;   // seconds
  locationId:    string;
  token_type:    string;
}

export async function exchangeGhlCode(code: string, redirectUri: string): Promise<GhlTokenResponse> {
  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      redirect_uri:  redirectUri,
      client_id:     process.env.GHL_CLIENT_ID!,
      client_secret: process.env.GHL_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL token exchange failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<GhlTokenResponse>;
}

export async function refreshGhlToken(refreshToken: string): Promise<GhlTokenResponse> {
  const res = await fetch(GHL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     process.env.GHL_CLIENT_ID!,
      client_secret: process.env.GHL_CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL token refresh failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<GhlTokenResponse>;
}
