export const INVITE_TTL_DAYS = 7;

const SUPABASE_URL = process.env.SUPABASE_ISSUER?.replace("/auth/v1", "") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export async function sendInviteEmail({
  to,
  inviteUrl,
}: {
  to: string;
  inviteUrl: string;
  businessName?: string | null;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_ISSUER and SUPABASE_SERVICE_ROLE_KEY must be set to send invite emails");
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ email: to, data: {}, redirect_to: inviteUrl }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase invite failed [${res.status}]: ${body}`);
  }
}
