import { it, expect } from "vitest";
import { invoiceHtml, renderHtmlToPdf } from "../render";
import type { InvoiceRenderData } from "../../../services/invoice.service";

const data: InvoiceRenderData = {
  invoiceNumber: "INV-2026-001",
  invoiceDate: "2026-01-01",
  visitDate: "2026-01-01",
  dueDate: null,
  paymentMethod: null,
  status: "DRAFT",
  currency: "£",
  customer: { name: '<script>alert(1)</script>', addressLine: "1 St", postcode: null, email: null, phone: null },
  lineItems: [{ description: "Clean", technicianName: null, amount: 10 }],
  subtotal: 10,
  vatAmount: 0,
  total: 10,
  amount: 10,
  business: { name: "Biz", email: null },
};

it("invoiceHtml escapes customer-controlled text (no raw script tag)", () => {
  const html = invoiceHtml(data);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});

it("renderHtmlToPdf throws 501 when GOTENBERG_URL is unset", async () => {
  const prev = process.env.GOTENBERG_URL;
  delete process.env.GOTENBERG_URL;
  try {
    await expect(renderHtmlToPdf("<p>x</p>")).rejects.toMatchObject({ statusCode: 501 });
  } finally {
    if (prev !== undefined) process.env.GOTENBERG_URL = prev;
  }
});
