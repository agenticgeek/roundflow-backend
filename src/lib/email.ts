import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.EMAIL_FROM ?? "RoundFlow <invites@roundflow.app>";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendInviteEmail({
  to,
  inviteUrl,
  businessName,
}: {
  to: string;
  inviteUrl: string;
  businessName?: string | null;
}): Promise<void> {
  const company = businessName ?? "a RoundFlow account";
  const safeCompany = escapeHtml(company);
  const safeUrl = encodeURI(inviteUrl);

  await resend.emails.send({
    from: FROM,
    to,
    subject: `You've been invited to join ${company} on RoundFlow`,
    html: `
      <p>You've been invited to join <strong>${safeCompany}</strong> on RoundFlow.</p>
      <p>Click the link below to accept your invitation. It expires in 7 days.</p>
      <p><a href="${safeUrl}">Accept invitation</a></p>
      <p>If you didn't expect this, you can safely ignore this email.</p>
    `,
    text: `You've been invited to join ${company} on RoundFlow.\n\nAccept your invitation (expires in 7 days):\n${inviteUrl}\n\nIf you didn't expect this, you can safely ignore this email.`,
  });
}
