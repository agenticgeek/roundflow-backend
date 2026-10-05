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
    throw new Error(`Stripe Connect token exchange failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<StripeConnectTokenResponse>;
}
