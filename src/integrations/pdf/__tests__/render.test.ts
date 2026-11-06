import { it, expect, vi } from "vitest";
import { invoiceHtml, renderHtmlToPdf } from "../render";
import type { InvoiceRenderData, InvoiceBusiness } from "../../../services/invoice.service";

const emptyBusiness: InvoiceBusiness = {
  name: "Biz", email: null, phone: null, address: null, vatNumber: null, companyNumber: null, bank: null,
  paymentTerms: "Payment due within 7 days", invoiceFooter: null,
};

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
  business: emptyBusiness,
  paymentReference: "INV-2026-001",
};

const full: InvoiceRenderData = {
  ...data,
  dueDate: "2026-01-08",
  vatAmount: 2,
  customer: { name: "Pat", addressLine: "2 Rd", postcode: "AB1 2CD", email: "p@x.test", phone: "07000" },
  lineItems: [{ description: "Clean", technicianName: "Tom", amount: 8 }],
  business: {
    name: "Shine Ltd",
    email: "hello@shine.test",
    phone: "01234 567890",
    address: { line1: "1 Main St", line2: "Unit 2", town: "Leeds", postcode: "LS1 1AA" },
    vatNumber: "GB123456789",
    companyNumber: "01234567",
    bank: { accountName: "Shine Ltd", bankName: "Bank plc", sortCode: "12-34-56", accountNumber: "12345678" },
    paymentTerms: "Payment due within 14 days",
    invoiceFooter: "Thank you!\nSee terms online.",
  },
};

it("invoiceHtml escapes customer-controlled text (no raw script tag)", () => {
  const html = invoiceHtml(data);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});

it("prints every tenant detail: name, address, VAT and company numbers, bank, terms, due date, reference, footer", () => {
  const html = invoiceHtml(full);
  for (const text of [
    "Shine Ltd", "1 Main St", "Unit 2", "Leeds, LS1 1AA", "hello@shine.test", "01234 567890",
    "VAT reg. no. GB123456789", "Company no. 01234567",
    "Account name: Shine Ltd", "Bank: Bank plc", "Sort code: 12-34-56", "Account number: 12345678",
    "Payment due within 14 days (due 2026-01-08)", "Payment reference: <strong>INV-2026-001</strong>",
    "Thank you!", "Tom",
  ]) {
    expect(html).toContain(text);
  }
  expect(html).toContain("<td class=\"r muted\">VAT</td>");
});

it("omits optional tenant blocks when they are not set", () => {
  const html = invoiceHtml(data);
  expect(html).not.toContain("VAT reg. no.");
  expect(html).not.toContain("Company no.");
  expect(html).not.toContain("Sort code");
  expect(html).not.toContain('class="foot');
  expect(html).toContain("Payment due within 7 days");
  expect(html).not.toContain("(due ");
  const noName = invoiceHtml({ ...data, business: { ...emptyBusiness, name: null } });
  expect(noName).toContain("<h1>Invoice</h1>");
});

it("handles a partial address and a bank without a bank name", () => {
  const html = invoiceHtml({
    ...data,
    business: { ...emptyBusiness, address: { line1: null, line2: null, town: null, postcode: "LS1 1AA" }, bank: { accountName: "A", bankName: null, sortCode: "1", accountNumber: "2" } },
  });
  expect(html).toContain("LS1 1AA");
  expect(html).not.toContain("Bank: ");
});

it("escapes every tenant-supplied value", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const html = invoiceHtml({
    ...full,
    paymentReference: evil,
    business: {
      name: evil, email: evil, phone: evil,
      address: { line1: evil, line2: evil, town: evil, postcode: evil },
      vatNumber: evil, companyNumber: evil,
      bank: { accountName: evil, bankName: evil, sortCode: evil, accountNumber: evil },
      paymentTerms: evil, invoiceFooter: evil,
    },
  });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
});

it("is an accessible document: lang, title, th scope, muted contrast >= 4.5:1", () => {
  const html = invoiceHtml(full);
  expect(html).toContain('<html lang="en">');
  expect(html).toContain("<title>Invoice INV-2026-001</title>");
  expect(html.match(/<th scope="col"/g)).toHaveLength(2);
  const muted = /\.muted\{color:(#[0-9a-f]{6});/.exec(html)![1];
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  expect((1 + 0.05) / (lum(muted) + 0.05)).toBeGreaterThanOrEqual(4.5);
  expect(invoiceHtml({ ...full, invoiceNumber: "<b>" })).toContain("<title>Invoice &lt;b&gt;</title>");
});

it("renderHtmlToPdf posts the html to Gotenberg and returns the PDF bytes; non-2xx becomes a 502", async () => {
  const prevUrl = process.env.GOTENBERG_URL;
  const prevFetch = global.fetch;
  process.env.GOTENBERG_URL = "http://gotenberg:3000/";
  try {
    const f = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    global.fetch = f as unknown as typeof fetch;
    const pdf = await renderHtmlToPdf("<p>x</p>");
    expect([...pdf]).toEqual([1, 2, 3]);
    expect(f.mock.calls[0][0]).toBe("http://gotenberg:3000/forms/chromium/convert/html");
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }) as unknown as typeof fetch;
    await expect(renderHtmlToPdf("<p>x</p>")).rejects.toMatchObject({ statusCode: 502 });
  } finally {
    global.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.GOTENBERG_URL;
    else process.env.GOTENBERG_URL = prevUrl;
  }
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
