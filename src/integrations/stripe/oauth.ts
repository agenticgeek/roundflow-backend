import { AppError } from "../../lib/app-error";

const STRIPE_AUTH_URL  = "https://connect.stripe.com/oauth/authorize";
const STRIPE_TOKEN_URL = "https://connect.stripe.com/oauth/token";

export function buildStripeAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     process.env.STRIPE_CLIENT_ID!,
    scope:         "read_write",
    state,
  });
  return `${STRIPE_AUTH_URL}?${params}`;
}

export interface StripeConnectTokenResponse {
  access_token:           string;
  stripe_user_id:         string;
  stripe_publishable_key: string;
  livemode:               boolean;
}

export async function exchangeStripeCode(code: string): Promise<StripeConnectTokenResponse> {
  const res = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY!}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[stripe/oauth] token exchange failed (${res.status}): ${body}`);
    // 4xx = the code was bad, used or expired (`invalid_grant`): the admin can retry the
    // connect, so it's a 400 with Stripe's reason. 5xx = Stripe itself failed: 502.
    if (res.status >= 500) {
      throw new AppError(502, "Stripe is unavailable — try connecting again shortly", "STRIPE_UNAVAILABLE");
    }
    throw new AppError(400, `Stripe didn't accept the connection: ${stripeReason(body)}`, "STRIPE_CONNECT_FAILED");
  }
  return res.json() as Promise<StripeConnectTokenResponse>;
}

/** Stripe's `error_description` (or `error`) from an OAuth error body; the raw text otherwise. */
function stripeReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; error_description?: string };
    return parsed.error_description || parsed.error || body;
  } catch {
    return body || "unknown error";
  }
}
