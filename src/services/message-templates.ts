import type { TenantDb } from "./visit-assignment";
import { AppError } from "../lib/app-error";

// Tenant message templates (Settings › Message templates) used by the
// payment-link, reminder, invoice and visit-completed sends (A5). A template is looked up by
// name; when the tenant has deleted or renamed it, the built-in fallback body
// is used instead so a send never fails for want of a template.

export const TEMPLATE_NAMES = {
  PAYMENT_LINK: "Payment Link",
  PAYMENT_REMINDER: "Payment Overdue Reminder",
  INVOICE: "Invoice Ready",
  VISIT_COMPLETED: "Visit completed",
  WEATHER_HOLD: "Weather Hold",
} as const;

export const FALLBACK_BODIES = {
  PAYMENT_LINK: "Hi {{firstName}}, you can pay invoice {{invoiceNumber}} ({{amount}}) online here: {{paymentLink}}",
  PAYMENT_REMINDER: "Hi {{firstName}}, our records show invoice {{invoiceNumber}} ({{amount}}) is unpaid. Please make payment at your earliest convenience.",
  INVOICE: "Hi {{firstName}}, your invoice {{invoiceNumber}} for {{amount}} is ready. Payment is due by {{dueDate}}. Thank you, {{businessName}}.",
  VISIT_COMPLETED: "Hi {{firstName}}, your window clean at {{address}} was completed today. Thank you, {{businessName}}.",
  WEATHER_HOLD: "Hi {{firstName}}, due to {{condition}} we've had to postpone your window clean at {{address}}. Your new date is {{newDate}}. Thanks for understanding, {{businessName}}.",
  // Used instead when the office will pick the new date later (no date to give).
  WEATHER_HOLD_TBC: "Hi {{firstName}}, due to {{condition}} we've had to postpone your window clean at {{address}}. We'll be in touch shortly with a new date. Thanks for understanding, {{businessName}}.",
} as const;

export type TemplateVars = Record<string, string>;

// C5: every {{variable}} a template may use — the union of what the senders
// actually supply: invoiceTemplateVars() (invoice/payment-link/reminder sends),
// the outbox worker's visit-completed vars, the pre-clean reminder vars, the
// round-message vars and the weather-hold vars (condition / newDate).
// Keep in sync when a sender adds a variable.
export const TEMPLATE_VARIABLES = [
  "address",
  "amount",
  "businessName",
  "condition",
  "customerName",
  "date",
  "dueDate",
  "firstName",
  "invoiceNumber",
  "newDate",
  "paymentLink",
  "roundName",
  "technicianName",
] as const;

// snake_case spellings (the web wizard's defaults and variable chips) accepted
// as aliases of the canonical camelCase tokens. Saved templates are normalised
// to the canonical form and rendering tolerates aliases already stored.
export const PLACEHOLDER_ALIASES: Record<string, (typeof TEMPLATE_VARIABLES)[number]> = {
  customer_name: "customerName",
  first_name: "firstName",
  business_name: "businessName",
  invoice_number: "invoiceNumber",
  due_date: "dueDate",
  payment_link: "paymentLink",
  round_name: "roundName",
  technician_name: "technicianName",
  visit_date: "date",
  next_visit_date: "date",
  next_clean_date: "date",
};

const PLACEHOLDER_RE = /\{\{\s*([\w.]*)\s*\}\}/g;

/** The canonical token for a placeholder key (aliases mapped), or the key itself. */
export function canonicalPlaceholder(key: string): string {
  return PLACEHOLDER_ALIASES[key] ?? key;
}

const isKnown = (key: string) => (TEMPLATE_VARIABLES as readonly string[]).includes(canonicalPlaceholder(key));

/** Rewrites snake_case aliases (and inner spaces) to the canonical {{camelCase}} form; other text untouched. */
export function normalizePlaceholders<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text.replace(PLACEHOLDER_RE, (m, key: string) => (isKnown(key) ? `{{${canonicalPlaceholder(key)}}}` : m)) as T;
}

/** 400 UNKNOWN_PLACEHOLDER when any {{variable}} in the given texts is not a known one (aliases count as known). */
export function assertKnownPlaceholders(...texts: Array<string | null | undefined>): void {
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? "").matchAll(PLACEHOLDER_RE)) {
      if (!isKnown(m[1])) unknown.add(m[1] || "(empty)");
    }
  }
  if (unknown.size > 0) {
    throw new AppError(
      400,
      `Unknown placeholder(s): ${[...unknown].map((u) => `{{${u}}}`).join(", ")}. Allowed: ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`,
      "UNKNOWN_PLACEHOLDER"
    );
  }
}

// "Customer Name" → "customerName" (the seeded templates use [Customer Name]).
function labelToKey(label: string): string {
  const [first, ...rest] = label.trim().split(/\s+/);
  return first.toLowerCase() + rest.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
}

// {{var}} placeholders always render — an unknown variable becomes "" (never a
// literal "{{x}}" in front of a customer). The legacy [Label] form only
// substitutes known variables, since square brackets can be ordinary text.
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? vars[canonicalPlaceholder(key)] ?? "")
    .replace(/\[([A-Za-z][A-Za-z ]*)\]/g, (m, label: string) => vars[labelToKey(label)] ?? m);
}

export async function loadTemplate(
  tp: TenantDb,
  name: string,
  fallback: string
): Promise<{ id: string | null; body: string; subject: string | null }> {
  const template = await tp.messageTemplate.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, body: true, subject: true },
  });
  return template ?? { id: null, body: fallback, subject: null };
}

/** "Monday 9 November" — visit dates are UTC-midnight date-only values. */
export function formatTemplateDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

export function formatMoney(amount: number, currency: string | null | undefined): string {
  return `${currency ?? "£"}${amount.toFixed(2)}`;
}

export function invoiceTemplateVars(input: {
  customerName: string;
  invoiceNumber: string;
  amount: number;
  dueDate: Date | null;
  currency?: string | null;
  businessName?: string | null;
  paymentLink?: string;
}): TemplateVars {
  return {
    customerName: input.customerName,
    firstName: input.customerName.split(" ")[0],
    invoiceNumber: input.invoiceNumber,
    amount: formatMoney(input.amount, input.currency),
    dueDate: input.dueDate ? input.dueDate.toISOString().slice(0, 10) : "",
    businessName: input.businessName ?? "",
    paymentLink: input.paymentLink ?? "",
  };
}
