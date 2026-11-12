import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail } from "../template";
import { contrastRatio } from "../contrast";

const brand = {
  businessName: "Sparkle <Windows> & Co",
  brandColour: "#00758C",
  logoUrl: "https://cdn.example.com/logo.png?x=1&y=2",
  logoAlt: "Sparkle logo",
  addressLines: ["1 High St", "Leeds", "LS1 1AA"],
  phone: "0113 000000",
  email: "owner@sparkle.co.uk",
  vatRegistration: "GB123456789",
  companyNumber: "01234567",
  termsUrl: "https://sparkle.co.uk/terms",
  privacyUrl: "https://sparkle.co.uk/privacy",
  footerText: "Thanks for choosing us",
};

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<a href="x">'&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;");
  });
});

describe("renderEmail", () => {
  const out = renderEmail({
    subject: "Invoice INV-1",
    preheader: "Your invoice is ready",
    bodyText: "Hi Ann,\nLine two\n\nSecond paragraph <b>x</b>",
    brand,
    cta: { label: "Pay now", url: "https://pay.example.com/x?a=1&b=2" },
    summary: [["Invoice", "INV-1"], ["Total", "£12.00"]],
    transactional: true,
  });

  it("is an accessible document: lang, title, charset, viewport, preheader", () => {
    expect(out.html).toMatch(/^<!DOCTYPE html>/);
    expect(out.html).toContain('<html lang="en-GB">');
    expect(out.html).toContain("<title>Invoice INV-1</title>");
    expect(out.html).toContain('<meta charset="utf-8">');
    expect(out.html).toContain('name="viewport"');
    expect(out.html).toContain("Your invoice is ready");
    expect(out.html).toMatch(/display:none[^"]*"[^>]*>Your invoice is ready/);
  });
  it("escapes tenant-supplied text everywhere", () => {
    expect(out.html).not.toContain("<Windows>");
    expect(out.html).toContain("Sparkle &lt;Windows&gt; &amp; Co");
    expect(out.html).not.toContain("<b>x</b>");
    expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("renders paragraphs and line breaks", () => {
    expect(out.html).toContain("Hi Ann,<br>Line two");
    expect(out.html.match(/<p /g)!.length).toBeGreaterThanOrEqual(2);
  });
  it("embeds the logo with alt text, and falls back to the name when there is none", () => {
    expect(out.html).toContain('alt="Sparkle logo"');
    expect(out.html).toContain("logo.png?x=1&amp;y=2");
    const noLogo = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "Acme" }, transactional: true });
    expect(noLogo.html).not.toContain("<img");
    expect(noLogo.html).toContain("Acme");
    const noAlt = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "Acme", logoUrl: "https://x.test/l.png" }, transactional: true });
    expect(noAlt.html).toContain('alt="Acme"');
  });
  it("CTA button colours: background = brand, text is the contrast-safe colour (>= 4.5:1)", () => {
    expect(out.html).toContain("background-color:#00758C");
    expect(out.html).toContain("color:#FFFFFF");
    expect(out.html).toContain('href="https://pay.example.com/x?a=1&amp;b=2"');
    const pale = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", brandColour: "#FFEB3B" }, cta: { label: "Go", url: "https://x.test" }, transactional: true });
    expect(pale.html).toContain("background-color:#FFEB3B");
    expect(pale.html).toContain("color:#000000");
    expect(contrastRatio("#FFEB3B", "#000000")).toBeGreaterThanOrEqual(4.5);
  });
  it("uses a contrast-safe link colour even for a brand that fails on white", () => {
    const teal = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", brandColour: "#029BB6" }, cta: { label: "Go", url: "https://x.test" }, transactional: true });
    expect(teal.html).not.toContain("color:#029BB6;text-decoration");
    expect(teal.html).toContain("background-color:#029BB6");
  });
  it("ignores a malformed brand colour (no CSS injection) and uses the default", () => {
    const bad = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", brandColour: "red;} body{display:none" }, cta: { label: "Go", url: "https://x.test" }, transactional: true });
    expect(bad.html).not.toContain("display:none}");
    expect(bad.html).toMatch(/background-color:#[0-9A-F]{6}/);
  });
  it("rejects non-http(s) CTA and logo URLs", () => {
    const o = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", logoUrl: "javascript:alert(1)" }, cta: { label: "Go", url: "javascript:alert(1)" }, transactional: true });
    expect(o.html).not.toContain("javascript:");
    expect(o.html).not.toContain("<img");
    expect(o.text).not.toContain("javascript:");
  });
  it("footer carries tenant name, address, contact, VAT and company number and policy links", () => {
    for (const s of ["1 High St", "Leeds", "LS1 1AA", "0113 000000", "owner@sparkle.co.uk", "GB123456789", "01234567", "https://sparkle.co.uk/terms", "https://sparkle.co.uk/privacy", "Thanks for choosing us"]) {
      expect(out.html).toContain(s);
      expect(out.text).toContain(s);
    }
  });
  it("summary table is a real table with header cells", () => {
    expect(out.html).toContain('<th scope="row"');
    expect(out.html).toContain("£12.00");
    expect(out.text).toContain("Total: £12.00");
  });
  it("transactional mail has no unsubscribe note, marketing-ish mail does", () => {
    expect(out.html).not.toMatch(/opt out|unsubscribe/i);
    const reminder = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "Acme", email: "a@acme.co" }, transactional: false });
    expect(reminder.html).toMatch(/reply to this email.*stop|opt out/i);
    expect(reminder.text).toMatch(/stop/i);
  });
  it("plain text part mirrors the content", () => {
    expect(out.text).toContain("Hi Ann,\nLine two");
    expect(out.text).toContain("Pay now: https://pay.example.com/x?a=1&b=2");
    expect(out.text).toContain("Sparkle <Windows> & Co");
    expect(out.text).not.toContain("&amp;");
  });
  it("renders a single policy link when only one is set", () => {
    const o = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", privacyUrl: "https://a.test/p" }, transactional: true });
    expect(o.html).toContain(">Privacy</a>");
    expect(o.html).not.toContain(">Terms</a>");
    const t = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A", termsUrl: "https://a.test/t" }, transactional: true });
    expect(t.html).toContain(">Terms</a>");
  });
  it("custom lang and no preheader/summary/cta/footer fields still render", () => {
    const o = renderEmail({ subject: "s", bodyText: "b", brand: { businessName: "A" }, transactional: true, lang: "en-US" });
    expect(o.html).toContain('lang="en-US"');
    expect(o.html).not.toContain("display:none");
  });
});
