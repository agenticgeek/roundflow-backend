import type { TenantDb } from "./visit-assignment";

// Tenant message templates (Settings › Message templates) used by the
// payment-link, reminder, invoice and visit-completed sends (A5). A template is looked up by
// name; when the tenant has deleted or renamed it, the built-in fallback body
// is used instead so a send never fails for want of a template.

export const TEMPLATE_NAMES = {
  PAYMENT_LINK: "Payment Link",
  PAYMENT_REMINDER: "Payment Overdue Reminder",
  INVOICE: "Invoice Ready",
  VISIT_COMPLETED: "Visit completed",
} as const;

export const FALLBACK_BODIES = {
  PAYMENT_LINK: "Hi {{firstName}}, you can pay invoice {{invoiceNumber}} ({{amount}}) online here: {{paymentLink}}",
  PAYMENT_REMINDER: "Hi {{firstName}}, our records show invoice {{invoiceNumber}} ({{amount}}) is unpaid. Please make payment at your earliest convenience.",
  INVOICE: "Hi {{firstName}}, your invoice {{invoiceNumber}} for {{amount}} is ready. Payment is due by {{dueDate}}. Thank you, {{businessName}}.",
  VISIT_COMPLETED: "Hi {{firstName}}, your window clean at {{address}} was completed today. Thank you, {{businessName}}.",
} as const;

export type TemplateVars = Record<string, string>;

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
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? "")
    .replace(/\[([A-Za-z][A-Za-z ]*)\]/g, (m, label: string) => vars[labelToKey(label)] ?? m);
}

export async function loadTemplate(
  tp: TenantDb,
  name: string,
  fallback: string
): Promise<{ id: string | null; body: string }> {
  const template = await tp.messageTemplate.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, body: true },
  });
  return template ?? { id: null, body: fallback };
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
