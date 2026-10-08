import { AppError } from "../../lib/app-error";
import type { InvoiceRenderData } from "../../services/invoice.service";

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
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new AppError(502, `PDF render failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Escape customer-controlled text before it lands in invoice HTML.
function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function invoiceHtml(d: InvoiceRenderData): string {
  const money = (n: number) => `${esc(d.currency)}${n.toFixed(2)}`;
  const rows = d.lineItems
    .map(
      (li) =>
        `<tr><td>${esc(li.description)}${li.technicianName ? ` <span class="muted">(${esc(li.technicianName)})</span>` : ""}</td><td class="r">${money(li.amount)}</td></tr>`
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;padding:40px;}
    h1{font-size:22px;margin:0 0 4px;} .muted{color:#777;} .r{text-align:right;}
    .head{display:flex;justify-content:space-between;margin-bottom:32px;}
    table{width:100%;border-collapse:collapse;margin-top:16px;}
    td,th{padding:8px 0;border-bottom:1px solid #eee;text-align:left;}
    tfoot td{border:0;} tfoot .total{font-weight:700;font-size:16px;border-top:2px solid #1a1a1a;}
  </style></head><body>
    <div class="head">
      <div><h1>${esc(d.business.name ?? "Invoice")}</h1><div class="muted">${esc(d.business.email ?? "")}</div></div>
      <div class="r"><h1>${esc(d.invoiceNumber)}</h1>
        <div class="muted">Issued ${esc(d.invoiceDate)}</div>
        ${d.dueDate ? `<div class="muted">Due ${esc(d.dueDate)}</div>` : ""}
        <div class="muted">${esc(d.status)}</div></div>
    </div>
    <div><strong>${esc(d.customer.name)}</strong><br>${esc(d.customer.addressLine)}${d.customer.postcode ? `, ${esc(d.customer.postcode)}` : ""}
      ${d.customer.email ? `<br>${esc(d.customer.email)}` : ""}${d.customer.phone ? `<br>${esc(d.customer.phone)}` : ""}</div>
    <table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td class="r muted">Subtotal</td><td class="r">${money(d.subtotal)}</td></tr>
        ${d.vatAmount ? `<tr><td class="r muted">VAT</td><td class="r">${money(d.vatAmount)}</td></tr>` : ""}
        <tr><td class="r total">Total</td><td class="r total">${money(d.total)}</td></tr>
      </tfoot>
    </table>
  </body></html>`;
}
