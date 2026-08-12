import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const INVITE_TTL_DAYS = 7;

const FROM = process.env.EMAIL_FROM ?? "RoundFlow <invites@roundflow.app>";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendTemplatedEmail({
  to,
  subject,
  body,
  variables,
}: {
  to: string;
  subject: string;
  body: string;
  variables: Record<string, string>;
}): Promise<void> {
  const rendered = body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = variables[key];
    return val !== undefined ? escapeHtml(val) : `{{${key}}}`;
  });
  const safeSubject = subject.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);

  await resend.emails.send({
    from: FROM,
    to,
    subject: safeSubject,
    html: `<p style="font-family:sans-serif;line-height:1.6">${rendered.replace(/\n/g, "<br>")}</p>`,
    text: body.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`),
  });
}

export async function sendInvoiceEmail({
  to,
  invoice,
  business,
}: {
  to: string;
  invoice: {
    invoiceNumber: string;
    invoiceDate: string;
    visitDate: string;
    dueDate: string | null;
    customerName: string;
    addressLine: string;
    lineItems: Array<{ description: string; technicianName: string | null; amount: number }>;
    subtotal: number;
    vatAmount: number;
    total: number;
  };
  business: { name: string | null; email: string | null };
}): Promise<void> {
  const biz = escapeHtml(business.name ?? "RoundFlow");
  const currency = "£";

  const lineRows = invoice.lineItems
    .map(
      (li) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(li.description)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center">${escapeHtml(li.technicianName ?? "")}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${currency}${li.amount.toFixed(2)}</td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto">
      <div style="background:#1a1a2e;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="margin:0;font-size:28px;letter-spacing:2px">INVOICE</h1>
        <p style="margin:4px 0 0;opacity:.7">#${escapeHtml(invoice.invoiceNumber)}</p>
      </div>
      <div style="padding:32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <table style="width:100%;margin-bottom:24px">
          <tr>
            <td style="vertical-align:top;width:50%">
              <strong>BILL TO</strong><br>
              ${escapeHtml(invoice.customerName)}<br>
              ${escapeHtml(invoice.addressLine)}
            </td>
            <td style="vertical-align:top;text-align:right">
              <strong>Invoice Date:</strong> ${escapeHtml(invoice.invoiceDate)}<br>
              <strong>Visit Date:</strong> ${escapeHtml(invoice.visitDate)}<br>
              ${invoice.dueDate ? `<strong>Due Date:</strong> ${escapeHtml(invoice.dueDate)}<br>` : ""}
            </td>
          </tr>
        </table>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid #eee">
              <th style="text-align:left;padding:8px 0">Description</th>
              <th style="text-align:center;padding:8px 0">Technician</th>
              <th style="text-align:right;padding:8px 0">Amount</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
        </table>
        <div style="text-align:right;margin-top:16px">
          <p style="margin:4px 0">Subtotal: ${currency}${invoice.subtotal.toFixed(2)}</p>
          <p style="margin:4px 0">VAT: ${currency}${invoice.vatAmount.toFixed(2)}</p>
          <p style="margin:4px 0;font-size:18px;font-weight:bold">Total Due: ${currency}${invoice.total.toFixed(2)}</p>
        </div>
        <hr style="margin:32px 0;border:none;border-top:1px solid #eee">
        <p style="color:#888;font-size:13px;text-align:center">
          Thank you for your business — ${biz}${business.email ? ` — ${escapeHtml(business.email)}` : ""}
        </p>
      </div>
    </div>`;

  await resend.emails.send({
    from: FROM,
    to,
    subject: `Invoice ${invoice.invoiceNumber} from ${business.name ?? "RoundFlow"}`,
    html,
    text: `Invoice ${invoice.invoiceNumber}\n\nTotal Due: ${currency}${invoice.total.toFixed(2)}\nDue Date: ${invoice.dueDate ?? "On receipt"}\n\nThank you for your business — ${business.name ?? "RoundFlow"}`,
  });
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
