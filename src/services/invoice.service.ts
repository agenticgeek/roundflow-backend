import { InvoiceStatus, MessageChannel, PaymentMethod, PaymentStatus, Prisma, VisitStatus } from "../generated/tenant-client";
import type { BusinessSettings } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { startOfUtcDay } from "../lib/schedule";
import { queueGhlEvent } from "../integrations/ghl/sync";
import { getCachedBusinessSettings } from "./settings.service";
import { createMessageService } from "./message.service";
import { releaseHoldIfSettled } from "./payment-hold";
import { FALLBACK_BODIES, TEMPLATE_NAMES, invoiceTemplateVars, loadTemplate, renderTemplate } from "./message-templates";
import type { TenantDb } from "./visit-assignment";

// ---------------------------------------------------------------------------
// M6 — Invoicing (BE-M6-04).
// ---------------------------------------------------------------------------

// ---- output types -----------------------------------------------------------

export interface InvoiceLineItem {
  description: string;
  technicianName: string | null;
  amount: number;
}

export interface InvoicePreview {
  invoiceNumber: string;
  invoiceDate: string;       // YYYY-MM-DD
  visitDate: string;         // YYYY-MM-DD
  dueDate: string | null;    // YYYY-MM-DD
  paymentMethod: string | null;
  customer: {
    name: string;
    addressLine: string;
    postcode: string | null;
    email: string | null;
    phone: string | null;
  };
  lineItems: InvoiceLineItem[];
  subtotal: number;
  vatAmount: number;
  total: number;
  amount: number;            // alias of total for convenience
  currency: string;          // business currency symbol, e.g. "£" / "€"
  business: {
    name: string | null;
    email: string | null;
  };
}

// Full data needed to render a saved invoice (PDF). Same shape as the preview
// plus the persisted status and the business currency symbol.
export type InvoiceRenderData = InvoicePreview & { status: string; currency: string };

// ---- Prisma include ---------------------------------------------------------

const visitInvoiceInclude = {
  property: {
    select: {
      addressLine: true,
      postcode: true,
      customer: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          paymentMethod: true,
          holdNextClean: true,
        },
      },
    },
  },
  round: { select: { name: true, defaultService: { select: { name: true } } } },
  technician: { select: { name: true } },
  service: { select: { name: true } },
  servicePlan: { select: { service: { select: { name: true } } } },
  invoice: { select: { id: true } },
} satisfies Prisma.VisitInclude;

type InvoiceVisit = Prisma.VisitGetPayload<{ include: typeof visitInvoiceInclude }>;

const invoiceListInclude = {
  customer: { select: { id: true, name: true, paymentMethod: true } },
  visit: { select: { paymentMethod: true, payment: { select: { method: true } } } },
} satisfies Prisma.InvoiceInclude;

type InvoiceListRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceListInclude }>;

// ---- helpers ----------------------------------------------------------------

const DAY_MS = 86_400_000;
const DEFAULT_LINE_DESCRIPTION = "Window cleaning";

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return +n.toFixed(2);
}

// B1: VAT comes from BusinessSettings.vatRate (default 20%).
function vatRateOf(settings: BusinessSettings | null): number {
  return settings?.vatRate != null ? Number(settings.vatRate) : 20;
}

// VAT added on top of a net amount (creating an invoice from a visit price).
function vatOn(subtotal: number, settings: BusinessSettings | null): number {
  return settings?.vatInInvoices ? round2((subtotal * vatRateOf(settings)) / 100) : 0;
}

// VAT contained in a saved gross total (rendering an existing invoice).
function vatWithin(total: number, settings: BusinessSettings | null): number {
  return settings?.vatInInvoices ? round2(total - total / (1 + vatRateOf(settings) / 100)) : 0;
}

// GAP-032: due date defaults to the issue date + BusinessSettings.invoiceDueDays.
function defaultDueDate(settings: BusinessSettings | null, now: Date = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() + (settings?.invoiceDueDays ?? 7) * DAY_MS);
}

// GAP-032: visit service → the plan's service → the round's default service →
// "Window cleaning".
function lineDescription(visit: Pick<InvoiceVisit, "service" | "servicePlan" | "round" | "date">): string {
  const serviceName =
    visit.service?.name ??
    visit.servicePlan?.service?.name ??
    visit.round?.defaultService?.name ??
    DEFAULT_LINE_DESCRIPTION;
  const roundPart = visit.round ? ` — ${visit.round.name}` : "";
  return `${serviceName}${roundPart} — ${toDateStr(visit.date)}`;
}

// Highest numeric suffix for the year + 1. (Counting rows would re-issue a
// number after a deletion, and lexicographic order breaks past 999.)
async function nextInvoiceNumber(db: TenantDb, now: Date = new Date()): Promise<string> {
  const prefix = `INV-${now.getFullYear()}-`;
  const rows = await db.invoice.findMany({
    where: { invoiceNumber: { startsWith: prefix } },
    select: { invoiceNumber: true },
  });
  const max = rows.reduce((m, r) => Math.max(m, Number(r.invoiceNumber.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// B5: invoice numbers must stay sequential under concurrency (two bulk runs,
// or a bulk run racing a single create). Each number is allocated inside a
// transaction holding a transaction-scoped Postgres advisory lock, keyed per
// tenant schema, so allocations serialise and the lock is released on
// commit/rollback. Chosen over SELECT … FOR UPDATE because there is no counter
// row to lock (numbers derive from existing invoices) and no schema change is
// needed; the unique index on invoiceNumber stays as the backstop.
async function lockInvoiceNumbering(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':invoice-number'))`;
}

function invoicePaymentMethod(inv: InvoiceListRow): PaymentMethod | null {
  return inv.visit?.payment?.method ?? inv.visit?.paymentMethod ?? inv.customer.paymentMethod ?? null;
}

// ---- contract ---------------------------------------------------------------

export interface CreateInvoiceInput {
  visitId: string;
  notes?: string | null;
  dueDate?: string | null; // YYYY-MM-DD
  sendEmail: boolean;
}

export interface InvoiceListFilters {
  status?: InvoiceStatus;
  from?: Date;
  to?: Date;          // inclusive day
  customerId?: string;
  q?: string;         // invoice number or customer name
}

export type ManualPaymentMethod = "BACS" | "CHEQUE" | "CASH";

export interface MarkPaidInput {
  method: ManualPaymentMethod;
  reference?: string | null;
  paidAt?: Date | null;
  amount?: number;
}

export type BulkSkipReason = "ALREADY_INVOICED" | "NOT_COMPLETED" | "ON_HOLD";

function invoiceWhere(f: InvoiceListFilters): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.customerId) where.customerId = f.customerId;
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lt: new Date(f.to.getTime() + DAY_MS) } : {}),
    };
  }
  if (f.q) {
    where.OR = [
      { invoiceNumber: { contains: f.q, mode: "insensitive" } },
      { customer: { name: { contains: f.q, mode: "insensitive" } } },
    ];
  }
  return where;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class InvoiceService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  // A visit that can be invoiced: exists, has no invoice yet, and is COMPLETED.
  private async loadInvoiceableVisit(visitId: string): Promise<InvoiceVisit> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: visitInvoiceInclude,
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.invoice) throw new AppError(409, "Visit already has an invoice", "ALREADY_INVOICED");
    if (visit.status !== VisitStatus.COMPLETED) {
      throw new AppError(409, "Only completed visits can be invoiced", "VISIT_NOT_COMPLETED");
    }
    return visit;
  }

  async listCustomerInvoices(customerId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      include: { visit: { select: { payment: { select: { id: true, status: true, method: true } } } } },
    });
    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      amount: inv.amount.toNumber(),
      dueDate: inv.dueDate,
      paidAt: inv.paidAt,
      sentToCustomer: inv.sentToCustomer,
      sentAt: inv.sentAt,
      createdAt: inv.createdAt,
      visitId: inv.visitId ?? null,
      payment: inv.visit?.payment ?? null,
    }));
  }

  // GET /invoices (GAP-028) — newest first.
  async listInvoices(filters: InvoiceListFilters, page: number, pageSize: number) {
    const where = invoiceWhere(filters);
    const [total, invoices] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: invoiceListInclude,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
    ]);
    return {
      rows: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customer: { id: inv.customer.id, name: inv.customer.name },
        total: inv.amount.toNumber(),
        status: inv.status,
        issuedAt: inv.createdAt,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        paymentMethod: invoicePaymentMethod(inv),
        visitId: inv.visitId ?? null,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  // GET /invoices/export.csv — every matching row, flattened for CSV.
  async exportInvoices(filters: InvoiceListFilters) {
    const invoices = await this.prisma.invoice.findMany({
      where: invoiceWhere(filters),
      include: invoiceListInclude,
      orderBy: { createdAt: "desc" },
    });
    return invoices.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customer.id,
      customerName: inv.customer.name,
      total: inv.amount.toNumber().toFixed(2),
      status: inv.status,
      issuedAt: inv.createdAt,
      dueDate: inv.dueDate,
      paidAt: inv.paidAt,
      paymentMethod: invoicePaymentMethod(inv),
    }));
  }

  // Richer than listCustomerInvoices: adds line items, technician, visit
  // date and a VAT/subtotal breakdown — the same data getRenderData()
  // assembles for the PDF, but tolerant of a standalone invoice with no
  // linked visit (getRenderData() 409s in that case; this degrades
  // gracefully instead, since a plain JSON detail view is also meant to
  // work for invoices that were never tied to a visit).
  async getInvoice(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true, paymentMethod: true } },
        visit: { include: visitInvoiceInclude },
      },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");

    const settings = await getCachedBusinessSettings(this.prisma);
    const total = invoice.amount.toNumber();
    const vatAmount = vatWithin(total, settings);
    const subtotal = round2(total - vatAmount);

    const visit = invoice.visit;

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      amount: total,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      notes: invoice.notes,
      sentToCustomer: invoice.sentToCustomer,
      sentAt: invoice.sentAt,
      createdAt: invoice.createdAt,
      customerId: invoice.customerId,
      visitId: invoice.visitId ?? null,
      visitDate: visit?.date ?? null,
      technicianName: visit?.technician?.name ?? null,
      roundName: visit?.round?.name ?? null,
      paymentMethod: visit?.paymentMethod ?? invoice.customer.paymentMethod ?? null,
      customer: {
        name: invoice.customer.name,
        email: invoice.customer.email,
        phone: invoice.customer.phone,
        addressLine: visit?.property.addressLine ?? null,
        postcode: visit?.property.postcode ?? null,
      },
      lineItems: visit
        ? [{ description: lineDescription(visit), technicianName: visit.technician?.name ?? null, amount: subtotal }]
        : [],
      subtotal,
      vatAmount,
    };
  }

  // A5 + D-7: delivered through GHL using the tenant's "Invoice Ready"
  // template. PAID/VOID invoices can't be sent; an already-SENT invoice needs
  // resend: true. The invoice only flips to SENT once GHL accepts.
  async sendInvoice(invoiceId: string, opts: { channel?: MessageChannel; resend?: boolean } = {}) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { customer: { select: { name: true } } },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.VOID) {
      throw new AppError(409, `Invoice is ${invoice.status.toLowerCase()} and cannot be sent`, "INVOICE_NOT_SENDABLE");
    }
    if (invoice.status === InvoiceStatus.SENT && !opts.resend) {
      throw new AppError(409, "Invoice has already been sent", "INVOICE_ALREADY_SENT");
    }

    const messages = createMessageService(this.prisma);
    const prep = await messages.prepare(invoice.customerId, opts.channel);
    const settings = await getCachedBusinessSettings(this.prisma);
    const template = await loadTemplate(this.prisma, TEMPLATE_NAMES.INVOICE, FALLBACK_BODIES.INVOICE);
    const body = renderTemplate(
      template.body,
      invoiceTemplateVars({
        customerName: invoice.customer.name,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount.toNumber(),
        dueDate: invoice.dueDate,
        currency: settings?.currency,
        businessName: settings?.businessName,
      })
    );
    const sent = await messages.deliver(prep, body, { templateId: template.id });

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: InvoiceStatus.SENT, sentToCustomer: true, sentAt: new Date() },
    });

    return {
      id: updated.id,
      invoiceNumber: updated.invoiceNumber,
      status: updated.status,
      sentToCustomer: updated.sentToCustomer,
      sentAt: updated.sentAt,
      messageId: sent.messageId,
      channel: sent.channel,
    };
  }

  // A7: record a manual (BACS / cheque / cash) payment against an invoice.
  // Creates or updates the visit's Payment row, marks the invoice PAID, logs
  // the activity, then runs the A3 hold auto-release.
  async markPaid(invoiceId: string, input: MarkPaidInput, actor?: { id?: string; role?: string }) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status === InvoiceStatus.PAID) throw new AppError(409, "Invoice is already paid", "INVOICE_ALREADY_PAID");
    if (invoice.status === InvoiceStatus.VOID) throw new AppError(409, "Invoice is void", "INVOICE_VOID");

    const total = invoice.amount.toNumber();
    if (input.amount !== undefined && Math.abs(input.amount - total) >= 0.005) {
      throw new AppError(
        400,
        `Amount ${input.amount.toFixed(2)} does not match the invoice total ${total.toFixed(2)} (part payments are not supported)`,
        "AMOUNT_MISMATCH"
      );
    }
    const paidAt = input.paidAt ?? new Date();
    const method = input.method as PaymentMethod;

    const { updatedInvoice, payment } = await this.prisma.$transaction(async (tx) => {
      const existing = invoice.visitId
        ? await tx.payment.findUnique({ where: { visitId: invoice.visitId } })
        : null;
      const paymentData = { amount: invoice.amount, method, status: PaymentStatus.PAID, paidAt, reference: input.reference ?? null };
      const payment = existing
        ? await tx.payment.update({ where: { id: existing.id }, data: paymentData })
        : await tx.payment.create({
            data: { ...paymentData, customerId: invoice.customerId, visitId: invoice.visitId ?? undefined },
          });
      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID, paidAt },
      });
      const ref = input.reference ? `, ref ${input.reference}` : "";
      await tx.activityLog.create({
        data: {
          type: "INVOICE_MARKED_PAID",
          message: `Invoice ${invoice.invoiceNumber} marked paid (${method}${ref})`,
          actorId: actor?.id ?? null,
          actorRole: actor?.role ?? null,
        },
      });
      return { updatedInvoice, payment };
    });

    queueGhlEvent(this.prisma, "payment.collected", invoice.customerId).catch(console.error);
    await releaseHoldIfSettled(this.prisma, invoice.customerId);

    return {
      invoice: {
        id: updatedInvoice.id,
        invoiceNumber: updatedInvoice.invoiceNumber,
        status: updatedInvoice.status,
        paidAt: updatedInvoice.paidAt,
        amount: updatedInvoice.amount.toNumber(),
      },
      payment: {
        id: payment.id,
        status: payment.status,
        method: payment.method,
        amount: payment.amount.toNumber(),
        paidAt: payment.paidAt,
        reference: payment.reference,
      },
    };
  }

  // Assemble the full renderable invoice from a *saved* invoice row (preview
  // refuses once an invoice exists, so this is its sibling for the PDF path).
  async getRenderData(invoiceId: string): Promise<InvoiceRenderData> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { visit: { include: visitInvoiceInclude } },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    const visit = invoice.visit;
    if (!visit) throw new AppError(409, "Invoice has no linked visit to render");

    const settings = await getCachedBusinessSettings(this.prisma);

    const total = invoice.amount.toNumber();
    const vatAmount = vatWithin(total, settings);
    const subtotal = round2(total - vatAmount);

    const customer = visit.property.customer;

    return {
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: toDateStr(invoice.createdAt),
      visitDate: toDateStr(visit.date),
      dueDate: invoice.dueDate ? toDateStr(invoice.dueDate) : null,
      paymentMethod: visit.paymentMethod ?? customer.paymentMethod ?? null,
      status: invoice.status,
      currency: settings?.currency ?? "£",
      customer: {
        name: customer.name,
        addressLine: visit.property.addressLine,
        postcode: visit.property.postcode ?? null,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
      },
      lineItems: [
        { description: lineDescription(visit), technicianName: visit.technician?.name ?? null, amount: subtotal },
      ],
      subtotal,
      vatAmount,
      total,
      amount: total,
      business: { name: settings?.businessName ?? null, email: settings?.email ?? null },
    };
  }

  async createInvoice(input: CreateInvoiceInput) {
    const visit = await this.loadInvoiceableVisit(input.visitId);
    const settings = await getCachedBusinessSettings(this.prisma);

    const subtotal = visit.price.toNumber();
    const total = new Prisma.Decimal(round2(subtotal + vatOn(subtotal, settings)));
    const dueDate = input.dueDate ? new Date(input.dueDate) : defaultDueDate(settings);

    const invoice = await this.prisma.$transaction(async (tx) => {
      await lockInvoiceNumbering(tx);
      const invoiceNumber = await nextInvoiceNumber(tx);
      return tx.invoice.create({
        data: {
          invoiceNumber,
          customerId: visit.property.customer.id,
          visitId: visit.id,
          amount: total,
          dueDate,
          notes: input.notes ?? null,
          status: InvoiceStatus.DRAFT,
          sentToCustomer: false,
        },
      });
    });

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      sentToCustomer: invoice.sentToCustomer,
      sentAt: invoice.sentAt,
      dueDate: invoice.dueDate,
      total: total.toNumber(),
    };
  }

  async previewInvoice(visitId: string): Promise<InvoicePreview> {
    const visit = await this.loadInvoiceableVisit(visitId);

    const [settings, invoiceNumber] = await Promise.all([
      getCachedBusinessSettings(this.prisma),
      nextInvoiceNumber(this.prisma),
    ]);

    const subtotal = visit.price.toNumber();
    const vatAmount = vatOn(subtotal, settings);
    const total = round2(subtotal + vatAmount);

    const customer = visit.property.customer;

    return {
      invoiceNumber,
      invoiceDate: toDateStr(new Date()),
      visitDate: toDateStr(visit.date),
      dueDate: toDateStr(defaultDueDate(settings)),
      paymentMethod: visit.paymentMethod ?? customer.paymentMethod ?? null,
      customer: {
        name: customer.name,
        addressLine: visit.property.addressLine,
        postcode: visit.property.postcode ?? null,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
      },
      lineItems: [
        {
          description: lineDescription(visit),
          technicianName: visit.technician?.name ?? null,
          amount: subtotal,
        },
      ],
      subtotal,
      vatAmount,
      total,
      amount: total,
      currency: settings?.currency ?? "£",
      business: {
        name: settings?.businessName ?? null,
        email: settings?.email ?? null,
      },
    };
  }

  // B5: what "Create invoices for today" would do for one date. Shared by
  // the preview and the create, so the two can't disagree.
  async previewBulk(date: Date, excludeVisitIds: string[] = []) {
    const day = startOfUtcDay(date);
    const visits = await this.prisma.visit.findMany({
      where: {
        date: { gte: day, lt: new Date(day.getTime() + DAY_MS) },
        status: { not: VisitStatus.CANCELLED },
        ...(excludeVisitIds.length ? { id: { notIn: excludeVisitIds } } : {}),
      },
      include: visitInvoiceInclude,
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });
    const settings = await getCachedBusinessSettings(this.prisma);

    const items: Array<{
      visitId: string; customerName: string; address: string;
      amount: number; vat: number; total: number; paymentMethod: PaymentMethod | null;
    }> = [];
    const skipped: Array<{ visitId: string; customerName: string; reason: BulkSkipReason }> = [];

    for (const v of visits) {
      const customer = v.property.customer;
      let reason: BulkSkipReason | null = null;
      if (v.invoice) reason = "ALREADY_INVOICED";
      else if (v.status !== VisitStatus.COMPLETED) reason = "NOT_COMPLETED";
      else if (v.paymentHold || customer.holdNextClean) reason = "ON_HOLD";
      if (reason) {
        skipped.push({ visitId: v.id, customerName: customer.name, reason });
        continue;
      }
      const amount = v.price.toNumber();
      const vat = vatOn(amount, settings);
      items.push({
        visitId: v.id,
        customerName: customer.name,
        address: [v.property.addressLine, v.property.postcode].filter(Boolean).join(", "),
        amount,
        vat,
        total: round2(amount + vat),
        paymentMethod: v.paymentMethod ?? customer.paymentMethod ?? null,
      });
    }

    const sum = items.reduce((s, i) => s + i.total, 0);
    return { items, skipped, totals: { count: items.length, amount: sum.toFixed(2) } };
  }

  // B5: per-item creation with partial-failure reporting — one bad visit
  // doesn't roll back the rest. sendNow sends each new invoice through A5; an
  // invoice that was created but couldn't be sent appears in both lists.
  async createBulk(
    date: Date,
    excludeVisitIds: string[] = [],
    opts: { sendNow?: boolean; channel?: MessageChannel } = {}
  ) {
    const { items } = await this.previewBulk(date, excludeVisitIds);
    const created: Array<{ visitId: string; invoiceId: string; invoiceNumber: string; total: number; sent?: boolean }> = [];
    const failed: Array<{ visitId: string; invoiceId?: string; error: string }> = [];

    for (const item of items) {
      let invoice: Awaited<ReturnType<InvoiceService["createInvoice"]>>;
      try {
        invoice = await this.createInvoice({ visitId: item.visitId, sendEmail: false });
      } catch (err) {
        failed.push({ visitId: item.visitId, error: (err as Error).message });
        continue;
      }
      const row = { visitId: item.visitId, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, total: invoice.total };
      created.push(row);
      if (!opts.sendNow) continue;
      try {
        await this.sendInvoice(invoice.id, { channel: opts.channel });
        Object.assign(row, { sent: true });
      } catch (err) {
        Object.assign(row, { sent: false });
        failed.push({ visitId: item.visitId, invoiceId: invoice.id, error: `Invoice created but not sent: ${(err as Error).message}` });
      }
    }

    const sum = created.reduce((s, c) => s + c.total, 0);
    return { created, failed, totals: { count: created.length, amount: sum.toFixed(2) } };
  }
}

export function createInvoiceService(prisma: TenantPrismaClient) {
  return new InvoiceService(prisma);
}
