export const INVITE_TTL_DAYS = 7;

const SUPABASE_URL = process.env.SUPABASE_ISSUER?.replace("/auth/v1", "") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Supabase Auth reads `redirect_to` from the query string (supabase-js sends it
// that way), not from the JSON body.
function supabaseAuthPost(path: string, redirectTo: string, body: unknown): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1${path}?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

// Supabase rejects /invite with 422 when the email already has a confirmed auth
// account (e.g. they clicked an earlier invite link, or signed up before). The
// wording/code differs between GoTrue versions, so match any of them.
function isExistingUserError(status: number, body: string): boolean {
  return status === 422 && /email_exists|user_already_exists|already been registered/i.test(body);
}

export async function sendInviteEmail({
  to,
  inviteUrl,
}: {
  to: string;
  inviteUrl: string;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_ISSUER and SUPABASE_SERVICE_ROLE_KEY must be set to send invite emails");
  }

  const res = await supabaseAuthPost("/invite", inviteUrl, { email: to, data: {} });
  if (res.ok) return;

  const body = await res.text();
  if (!isExistingUserError(res.status, body)) {
    throw new Error(`Supabase invite failed [${res.status}]: ${body}`);
  }

  // Existing account: send a magic link to the same accept-invite URL instead,
  // so they land in exactly the same flow, already signed in.
  const otp = await supabaseAuthPost("/otp", inviteUrl, { email: to, create_user: false });
  if (!otp.ok) {
    throw new Error(`Supabase sign-in link failed [${otp.status}]: ${await otp.text()}`);
  }
}
