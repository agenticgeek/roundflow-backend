import { AppError } from "../app-error";

// GHL-11: per-tenant sender identity. Everything a tenant can type that ends up in an email header is validated
// here (no line breaks, quotes, <>, length caps), so a tenant cannot inject headers or pose as another brand.

const MAX_NAME = 70;
// eslint-disable-next-line no-control-regex -- intentionally rejects control characters (header injection)
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f"<>;@]/;

export function validateSenderName(v: unknown): string {
  const fail = (): never => {
    throw new AppError(
      400,
      `emailSenderName must be 1-${MAX_NAME} characters without line breaks, quotes, < > ; or @`,
      "INVALID_EMAIL_SENDER_NAME"
    );
  };
  if (typeof v !== "string") return fail();
  const name = v.trim();
  if (name.length < 1 || name.length > MAX_NAME || NAME_FORBIDDEN.test(name)) return fail();
  return name;
}

/** For names we did not validate (the business name): strip what a header cannot carry instead of failing. */
export function sanitiseDisplayName(v: string | null | undefined): string {
  return (v ?? "")
// eslint-disable-next-line no-control-regex -- intentionally rejects control characters (header injection)
    .replace(/[\u0000-\u001f\u007f@:;]/g, " ")
    .replace(/["<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
}

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateEmailAddress(v: unknown, field: string): string {
  if (typeof v === "string") {
    const addr = v.trim().toLowerCase();
    if (addr.length <= 254 && addr.indexOf("@") <= 64 && ADDRESS_RE.test(addr)) return addr;
  }
  throw new AppError(400, `${field} must be a single valid email address`, "INVALID_EMAIL_ADDRESS");
}

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validateLocalPart(v: unknown): string {
  if (typeof v === "string") {
    const local = v.trim().toLowerCase();
    if (LOCAL_PART_RE.test(local) && !local.includes("..")) return local;
  }
  throw new AppError(400, "emailSenderLocalPart must be 1-64 letters, digits, dots, dashes or underscores", "INVALID_EMAIL_LOCAL_PART");
}

const FREE_MAIL = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "gmx.co.uk", "mail.com", "zoho.com", "btinternet.com", "sky.com", "talktalk.net", "virginmedia.com",
];
const FREE_MAIL_PATTERN = /^(hotmail|outlook|yahoo|live)\.[a-z.]+$/;

export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return FREE_MAIL.some((f) => d === f || d.endsWith("." + f)) || FREE_MAIL_PATTERN.test(d);
}

const RESERVED = ["roundflow.ai", "amazonses.com", "amazonaws.com", "supabase.co", "supabase.com"];
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Validates a tenant-owned sending domain. Free-mail → FREE_MAIL_DOMAIN; platform domains → RESERVED_EMAIL_DOMAIN. */
export function validateSenderDomain(v: unknown, sharedDomain: string | null): string {
  const domain = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (domain.length > 253 || !DOMAIN_RE.test(domain)) {
    throw new AppError(400, "emailSenderDomain must be a domain name such as example.co.uk", "INVALID_EMAIL_DOMAIN");
  }
  if (isFreeMailDomain(domain)) {
    throw new AppError(
      400,
      "Free mailbox domains (gmail, outlook, yahoo, icloud...) cannot be used to send email. Your emails are sent from RoundFlow's shared address with your business name and your address as the reply-to.",
      "FREE_MAIL_DOMAIN"
    );
  }
  const reserved = sharedDomain ? [...RESERVED, sharedDomain] : RESERVED;
  if (reserved.some((r) => domain === r || domain.endsWith("." + r) || r.endsWith("." + domain))) {
    throw new AppError(400, "That domain belongs to RoundFlow or its providers and cannot be used.", "RESERVED_EMAIL_DOMAIN");
  }
  return domain;
}

/** `"Name" <address>`; non-ASCII names are RFC 2047 encoded. No name = the bare address. */
export function buildFromHeader(displayName: string, address: string): string {
  if (!displayName) return address;
  const printable = /^[\x20-\x7e]*$/.test(displayName);
  const name = printable ? displayName : `=?UTF-8?B?${Buffer.from(displayName, "utf8").toString("base64")}?=`;
  return `"${name}" <${address}>`;
}

export interface SenderSettings {
  businessName: string | null;
  email: string | null;
  emailSenderName: string | null;
  emailReplyTo: string | null;
  emailSenderDomain: string | null;
  emailSenderLocalPart: string | null;
  emailDomainStatus: string;
}

export interface ResolvedSender {
  /** 1 = shared RoundFlow address, 2 = the tenant's verified domain. */
  tier: 1 | 2;
  from: string;
  fromAddress: string;
  displayName: string;
  replyTo?: string;
}

function usableAddress(v: string | null): string | undefined {
  if (!v) return undefined;
  const addr = v.trim().toLowerCase();
  return addr.length <= 254 && ADDRESS_RE.test(addr) ? addr : undefined;
}

export function resolveSender(s: SenderSettings, sharedFromAddress: string): ResolvedSender {
  const displayName = sanitiseDisplayName(s.emailSenderName || s.businessName);
  const replyTo = usableAddress(s.emailReplyTo) ?? usableAddress(s.email);
  const tier2 = s.emailDomainStatus === "VERIFIED" && !!s.emailSenderDomain;
  const fromAddress = tier2 ? `${s.emailSenderLocalPart || "accounts"}@${s.emailSenderDomain}` : sharedFromAddress;
  return { tier: tier2 ? 2 : 1, from: buildFromHeader(displayName, fromAddress), fromAddress, displayName, replyTo };
}
