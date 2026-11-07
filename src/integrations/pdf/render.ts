import { AppError } from "../../lib/app-error";
import type { InvoiceRenderData } from "../../services/invoice.service";
import { outboundSignal, PDF_OUTBOUND_TIMEOUT_MS } from "../../lib/outbound";

// HTML -> PDF via a Gotenberg render service (https://gotenberg.dev).
// Chosen over bundling headless Chrome (puppeteer) or a paid SaaS: Gotenberg is
// open-source, self-hostable, has no per-call billing or API keys, and keeps
// Chromium out of this process. Point GOTENBERG_URL at the running container.
// ponytail: single render host; swap GOTENBERG_URL to change provider.
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const base = process.env.GOTENBERG_URL;
  if (!base) throw new AppError(501, "PDF rendering is not configured (set GOTENBERG_URL)");

  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");

  const res = await fetch(`${base.replace(/\/$/, "")}/forms/chromium/convert/html`, {
    signal: outboundSignal(PDF_OUTBOUND_TIMEOUT_MS),
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new AppError(502, `PDF render failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Escape customer-controlled text before it lands in invoice HTML.
function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// GHL-10: .muted was #777 (4.48:1 on white, just under WCAG AA); #595959 is 7:1.
export function invoiceHtml(d: InvoiceRenderData): string {
  const money = (n: number) => `${esc(d.currency)}${n.toFixed(2)}`;
  const rows = d.lineItems
    .map(
      (li) =>
        `<tr><td>${esc(li.description)}${li.technicianName ? ` <span class="muted">(${esc(li.technicianName)})</span>` : ""}</td><td class="r">${money(li.amount)}</td></tr>`
    )
    .join("");

  const b = d.business;
  const addressLines = b.address
    ? [b.address.line1, b.address.line2, [b.address.town, b.address.postcode].filter(Boolean).join(", ")].filter((l): l is string => Boolean(l))
    : [];
  const supplier = [
    ...addressLines.map((l) => esc(l)),
    b.email ? esc(b.email) : "",
    b.phone ? esc(b.phone) : "",
    b.vatNumber ? `VAT reg. no. ${esc(b.vatNumber)}` : "",
    b.companyNumber ? `Company no. ${esc(b.companyNumber)}` : "",
  ].filter(Boolean);
  const bankLines = b.bank
    ? [
        `Account name: ${esc(b.bank.accountName)}`,
        b.bank.bankName ? `Bank: ${esc(b.bank.bankName)}` : "",
        `Sort code: ${esc(b.bank.sortCode)}`,
        `Account number: ${esc(b.bank.accountNumber)}`,
      ].filter(Boolean)
    : [];

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(d.invoiceNumber)}</title><style>
    body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;padding:40px;}
    h1{font-size:22px;margin:0 0 4px;} h2{font-size:14px;margin:0 0 4px;} .muted{color:#595959;} .r{text-align:right;}
    .head{display:flex;justify-content:space-between;margin-bottom:32px;}
    table{width:100%;border-collapse:collapse;margin-top:16px;}
    td,th{padding:8px 0;border-bottom:1px solid #eee;text-align:left;}
    tfoot td{border:0;} tfoot .total{font-weight:700;font-size:16px;border-top:2px solid #1a1a1a;}
    .pay{margin-top:32px;} .foot{margin-top:24px;white-space:pre-line;}
  </style></head><body>
    <div class="head">
      <div><h1>${esc(b.name ?? "Invoice")}</h1>${supplier.length ? `<div class="muted">${supplier.join("<br>")}</div>` : ""}</div>
      <div class="r"><h1>${esc(d.invoiceNumber)}</h1>
        <div class="muted">Issued ${esc(d.invoiceDate)}</div>
        ${d.dueDate ? `<div class="muted">Due ${esc(d.dueDate)}</div>` : ""}
        <div class="muted">${esc(d.status)}</div></div>
    </div>
    <div><strong>${esc(d.customer.name)}</strong><br>${esc(d.customer.addressLine)}${d.customer.postcode ? `, ${esc(d.customer.postcode)}` : ""}
      ${d.customer.email ? `<br>${esc(d.customer.email)}` : ""}${d.customer.phone ? `<br>${esc(d.customer.phone)}` : ""}</div>
    <table><thead><tr><th scope="col">Description</th><th scope="col" class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td class="r muted">Subtotal</td><td class="r">${money(d.subtotal)}</td></tr>
        ${d.vatAmount ? `<tr><td class="r muted">VAT</td><td class="r">${money(d.vatAmount)}</td></tr>` : ""}
        <tr><td class="r total">Total</td><td class="r total">${money(d.total)}</td></tr>
      </tfoot>
    </table>
    <div class="pay"><h2>Payment</h2>
      <div>${esc(b.paymentTerms)}${d.dueDate ? ` (due ${esc(d.dueDate)})` : ""}</div>
      <div>Payment reference: <strong>${esc(d.paymentReference)}</strong></div>
      ${bankLines.length ? `<div class="muted">${bankLines.join("<br>")}</div>` : ""}
    </div>
    ${b.invoiceFooter ? `<div class="foot muted">${esc(b.invoiceFooter)}</div>` : ""}
  </body></html>`;
}
