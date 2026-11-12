import { DEFAULT_BRAND_COLOUR, isHexColour, normaliseHex, readableTextColour, safeAccentColour } from "./contrast";

// Branded, accessible HTML email wrapper plus a plain-text part (GHL-07, BE-31). Every tenant-supplied string is
// escaped; colours are validated hex (no CSS injection) and the button text colour is computed for >= 4.5:1.

export interface EmailBrand {
  businessName: string;
  brandColour?: string | null;
  logoUrl?: string | null;
  logoAlt?: string | null;
  addressLines?: string[];
  phone?: string | null;
  email?: string | null;
  vatRegistration?: string | null;
  companyNumber?: string | null;
  termsUrl?: string | null;
  privacyUrl?: string | null;
  footerText?: string | null;
}

export interface RenderEmailInput {
  subject: string;
  preheader?: string;
  /** Plain text (already template-rendered); blank lines separate paragraphs. */
  bodyText: string;
  brand: EmailBrand;
  cta?: { label: string; url: string };
  summary?: Array<[string, string]>;
  /** Transactional mail (invoices, receipts) carries no opt-out note; reminders and notices do. */
  transactional: boolean;
  lang?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

const INK = "#1F2937";
const MUTED = "#4B5563";

export function renderEmail(input: RenderEmailInput): { html: string; text: string } {
  const { brand } = input;
  const colour = isHexColour(brand.brandColour) ? normaliseHex(brand.brandColour) : DEFAULT_BRAND_COLOUR;
  const buttonText = readableTextColour(colour);
  const accent = safeAccentColour(colour);
  const lang = input.lang ?? "en-GB";
  const logo = safeUrl(brand.logoUrl);
  const cta = input.cta && safeUrl(input.cta.url) ? input.cta : undefined;
  const termsUrl = safeUrl(brand.termsUrl);
  const privacyUrl = safeUrl(brand.privacyUrl);

  const paragraphs = input.bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const bodyHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${INK}">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

  const summaryHtml = input.summary?.length
    ? `<table style="border-collapse:collapse;margin:0 0 20px;width:100%"><tbody>${input.summary
        .map(
          ([k, v]) =>
            `<tr><th scope="row" style="text-align:left;padding:6px 12px 6px 0;font-weight:600;font-size:15px;color:${MUTED}">${escapeHtml(k)}</th><td style="padding:6px 0;font-size:15px;color:${INK}">${escapeHtml(v)}</td></tr>`
        )
        .join("")}</tbody></table>`
    : "";

  const ctaHtml = cta
    ? `<p style="margin:0 0 24px"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background-color:${colour};color:${buttonText};font-size:16px;font-weight:600;line-height:1.2;padding:14px 24px;border-radius:6px;text-decoration:none">${escapeHtml(cta.label)}</a></p>`
    : "";

  const headerHtml = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brand.logoAlt || brand.businessName)}" style="display:block;max-height:56px;max-width:220px;height:auto;border:0">`
    : `<span style="font-size:20px;font-weight:700;color:${accent}">${escapeHtml(brand.businessName)}</span>`;

  const address = (brand.addressLines ?? []).filter(Boolean);
  const contact = [brand.phone, brand.email].filter((x): x is string => !!x);
  const legal = [
    brand.vatRegistration ? `VAT registration: ${brand.vatRegistration}` : "",
    brand.companyNumber ? `Company number: ${brand.companyNumber}` : "",
  ].filter(Boolean);
  const optOut = input.transactional
    ? ""
    : `To opt out of these messages, reply to this email and tell us to stop.`;

  const footerParts: string[] = [
    `<strong>${escapeHtml(brand.businessName)}</strong>`,
    ...(address.length ? [escapeHtml(address.join(", "))] : []),
    ...(contact.length ? [escapeHtml(contact.join(" | "))] : []),
    ...legal.map(escapeHtml),
    ...(brand.footerText ? [escapeHtml(brand.footerText)] : []),
    ...(termsUrl || privacyUrl
      ? [
          [termsUrl ? `<a href="${escapeHtml(termsUrl)}" style="color:${accent}">Terms</a>` : "", privacyUrl ? `<a href="${escapeHtml(privacyUrl)}" style="color:${accent}">Privacy</a>` : ""]
            .filter(Boolean)
            .join(" | "),
        ]
      : []),
    ...(optOut ? [escapeHtml(optOut)] : []),
  ];
  const footerHtml = footerParts.map((p) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${MUTED}">${p}</p>`).join("");

  const preheader = input.preheader
    ? `<span style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(input.preheader)}</span>`
    : "";

  const html =
    `<!DOCTYPE html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${escapeHtml(input.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#F3F4F6">${preheader}` +
    `<table role="presentation" width="100%" style="background-color:#F3F4F6"><tbody><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" style="max-width:600px;background-color:#FFFFFF;border-radius:8px;border-top:4px solid ${colour}"><tbody>` +
    `<tr><td style="padding:24px 32px 8px">${headerHtml}</td></tr>` +
    `<tr><td style="padding:16px 32px 8px;font-family:Arial,Helvetica,sans-serif">${bodyHtml}${summaryHtml}${ctaHtml}</td></tr>` +
    `<tr><td style="padding:16px 32px 28px;border-top:1px solid #E5E7EB;font-family:Arial,Helvetica,sans-serif">${footerHtml}</td></tr>` +
    `</tbody></table></td></tr></tbody></table></body></html>`;

  const textLines = [
    paragraphs.join("\n\n"),
    ...(input.summary?.length ? ["", ...input.summary.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(cta ? ["", `${cta.label}: ${cta.url}`] : []),
    "",
    "--",
    brand.businessName,
    ...(address.length ? [address.join(", ")] : []),
    ...contact,
    ...legal,
    ...(brand.footerText ? [brand.footerText] : []),
    ...(termsUrl ? [`Terms: ${termsUrl}`] : []),
    ...(privacyUrl ? [`Privacy: ${privacyUrl}`] : []),
    ...(optOut ? [optOut] : []),
  ];
  return { html, text: textLines.join("\n") };
}
