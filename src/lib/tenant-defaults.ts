import type { TenantPrismaClient } from "./tenant-prisma-manager";

// Default rows written into a brand-new tenant schema so the first admin
// doesn't land on an empty Settings/Services screen. Mirrors the sample data
// the frontend used to hardcode client-side — now these are real DB rows the
// tenant can edit or delete like any other Service/MessageTemplate.

export const DEFAULT_SERVICES = [
  { name: "Standard Window Clean", category: "WINDOW_CLEANING", defaultPrice: "25.00", description: "Interior and exterior window clean, standard-height properties." },
  { name: "Conservatory Roof Clean", category: "SPECIALIST", defaultPrice: "45.00", description: "Glass roof panel clean, moss and algae removal." },
  { name: "Gutter Clearing", category: "GUTTER_FASCIA", defaultPrice: "60.00", description: "Clear debris and check downpipe flow." },
  { name: "Fascia & Soffit Clean", category: "GUTTER_FASCIA", defaultPrice: "35.00", description: "Exterior fascia/soffit wash." },
  { name: "Solar Panel Clean", category: "SPECIALIST", defaultPrice: "55.00", description: "Deionised-water panel clean to restore output." },
  { name: "One-Off Deep Clean", category: "DEFAULT", defaultPrice: "40.00", description: "First-visit deep clean before a property joins a recurring round." },
] as const;

export const DEFAULT_MESSAGE_TEMPLATES = [
  { name: "Appointment Reminder", channel: "SMS", subject: null, body: "Hi [Customer Name], this is a reminder your clean is scheduled for tomorrow. Reply STOP to opt out." },
  { name: "Missed Visit Notice", channel: "SMS", subject: null, body: "Hi [Customer Name], we were unable to complete your visit today. We'll be in touch to rebook." },
  { name: "Invoice Ready", channel: "EMAIL", subject: "Your invoice is ready", body: "Hi [Customer Name], your latest invoice is attached. Thank you for your business." },
  { name: "Payment Overdue Reminder", channel: "SMS", subject: null, body: "Hi [Customer Name], our records show an overdue balance. Please make payment at your earliest convenience." },
  { name: "Complaint Acknowledgement", channel: "EMAIL", subject: "We've received your message", body: "Hi [Customer Name], we've logged your complaint and will be in touch shortly." },
  { name: "Welcome / Service Confirmation", channel: "SMS", subject: null, body: "Hi [Customer Name], welcome to our round! Your first visit is confirmed." },
] as const;

// Idempotent: each table is seeded only if it is currently empty, so this is
// safe to call on every signup/provisioning attempt (including crash-recovery
// retries) without ever duplicating rows for a tenant that already has data.
export async function seedTenantDefaults(tenantPrisma: TenantPrismaClient): Promise<void> {
  const [serviceCount, templateCount] = await Promise.all([
    tenantPrisma.service.count(),
    tenantPrisma.messageTemplate.count(),
  ]);

  if (serviceCount === 0) {
    await tenantPrisma.service.createMany({ data: DEFAULT_SERVICES.map((s) => ({ ...s })) });
  }

  if (templateCount === 0) {
    await tenantPrisma.messageTemplate.createMany({ data: DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ ...t })) });
  }
}
