import { Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { sendInvoiceEmail } from "../lib/email";

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
  dueDate: string | null;    // YYYY-MM-DD — null until explicitly set
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
  business: {
    name: string | null;
    email: string | null;
  };
}

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
        },
      },
    },
  },
  round: { select: { name: true } },
  technician: { select: { name: true } },
  service: { select: { name: true } },
  invoice: { select: { id: true } },
} satisfies Prisma.VisitInclude;

// ---- helpers ----------------------------------------------------------------

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function nextInvoiceNumber(prisma: TenantPrismaClient): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.invoice.findMany({
    where: { invoiceNumber: { startsWith: `INV-${year}-` } },
    select: { id: true },
  });
  return `INV-${year}-${String(count.length + 1).padStart(3, "0")}`;
}

// ---- contract ---------------------------------------------------------------

export interface CreateInvoiceInput {
  visitId: string;
  notes?: string | null;
  dueDate?: string | null; // YYYY-MM-DD
  sendEmail: boolean;
}

export interface IInvoiceService {
  previewInvoice(visitId: string): Promise<InvoicePreview>;
  listCustomerInvoices(customerId: string): Promise<Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    amount: number;
    dueDate: Date | null;
    sentToCustomer: boolean;
    sentAt: Date | null;
    createdAt: Date;
    visitId: string | null;
  }>>;
  getInvoice(invoiceId: string): Promise<{
    id: string;
    invoiceNumber: string;
    status: string;
    amount: number;
    dueDate: Date | null;
    notes: string | null;
    sentToCustomer: boolean;
    sentAt: Date | null;
    createdAt: Date;
    customerId: string;
    visitId: string | null;
  }>;
  sendInvoice(invoiceId: string): Promise<{
    id: string;
    invoiceNumber: string;
    status: string;
    sentToCustomer: boolean;
    sentAt: Date | null;
  }>;
  createInvoice(input: CreateInvoiceInput): Promise<{
    id: string;
    invoiceNumber: string;
    status: string;
    sentToCustomer: boolean;
    sentAt: Date | null;
  }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class InvoiceService implements IInvoiceService {
  constructor(private readonly prisma: TenantPrismaClient) {}

  async listCustomerInvoices(customerId: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });
    return invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      amount: inv.amount.toNumber(),
      dueDate: inv.dueDate,
      sentToCustomer: inv.sentToCustomer,
      sentAt: inv.sentAt,
      createdAt: inv.createdAt,
      visitId: inv.visitId ?? null,
    }));
  }

  async getInvoice(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new AppError(404, "Invoice not found");
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      amount: invoice.amount.toNumber(),
      dueDate: invoice.dueDate,
      notes: invoice.notes,
      sentToCustomer: invoice.sentToCustomer,
      sentAt: invoice.sentAt,
      createdAt: invoice.createdAt,
      customerId: invoice.customerId,
      visitId: invoice.visitId ?? null,
    };
  }

  async sendInvoice(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: { select: { name: true, email: true } },
        visit: {
          select: {
            date: true,
            price: true,
            round: { select: { name: true } },
            technician: { select: { name: true } },
            service: { select: { name: true } },
            property: { select: { addressLine: true, postcode: true } },
          },
        },
      },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    if (invoice.status === "SENT") throw new AppError(409, "Invoice has already been sent");

    const email = invoice.customer.email;
    if (!email) throw new AppError(400, "Customer has no email address — cannot send invoice");

    const settings = await this.prisma.businessSettings.findFirst({
      select: { businessName: true, email: true, vatInInvoices: true },
    });

    const subtotal = invoice.amount.toNumber();
    const vatAmount = settings?.vatInInvoices ? +(subtotal * 0.2).toFixed(2) : 0;
    const total = +(subtotal + vatAmount).toFixed(2);
    const visit = invoice.visit;

    await sendInvoiceEmail({
      to: email,
      invoice: {
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: toDateStr(invoice.createdAt),
        visitDate: visit ? toDateStr(visit.date) : toDateStr(invoice.createdAt),
        dueDate: invoice.dueDate ? toDateStr(invoice.dueDate) : null,
        customerName: invoice.customer.name,
        addressLine: visit?.property.addressLine ?? "",
        lineItems: [
          {
            description: visit
              ? `${visit.service?.name ?? "Window Cleaning Service"} — ${visit.round?.name ?? ""} — ${toDateStr(visit.date)}`
              : "Window Cleaning Service",
            technicianName: visit?.technician?.name ?? null,
            amount: subtotal,
          },
        ],
        subtotal,
        vatAmount,
        total,
      },
      business: {
        name: settings?.businessName ?? null,
        email: settings?.email ?? null,
      },
    });

    const updated = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "SENT", sentToCustomer: true, sentAt: new Date() },
    });

    return {
      id: updated.id,
      invoiceNumber: updated.invoiceNumber,
      status: updated.status,
      sentToCustomer: updated.sentToCustomer,
      sentAt: updated.sentAt,
    };
  }

  async createInvoice(input: CreateInvoiceInput) {
    const visit = await this.prisma.visit.findUnique({
      where: { id: input.visitId },
      include: visitInvoiceInclude,
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.invoice) throw new AppError(409, "Visit already has an invoice");

    const [settings, invoiceNumber] = await Promise.all([
      this.prisma.businessSettings.findFirst({
        select: { businessName: true, email: true, vatInInvoices: true, vatRegistered: true, currency: true },
      }),
      nextInvoiceNumber(this.prisma),
    ]);

    const subtotal = visit.price.toNumber();
    const vatAmount = settings?.vatInInvoices ? +(subtotal * 0.2).toFixed(2) : 0;
    const total = new Prisma.Decimal(subtotal + vatAmount);

    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNumber,
        customerId: visit.property.customer.id,
        visitId: visit.id,
        amount: total,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        notes: input.notes ?? null,
        status: "DRAFT",
        sentToCustomer: false,
      },
    });

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      sentToCustomer: invoice.sentToCustomer,
      sentAt: invoice.sentAt,
    };
  }

  async previewInvoice(visitId: string): Promise<InvoicePreview> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: visitInvoiceInclude,
    });
    if (!visit) throw new AppError(404, "Visit not found");
    if (visit.invoice) throw new AppError(409, "Visit already has an invoice");

    const [settings, invoiceNumber] = await Promise.all([
      this.prisma.businessSettings.findFirst({
        select: { businessName: true, email: true, vatInInvoices: true, vatRegistered: true, currency: true },
      }),
      nextInvoiceNumber(this.prisma),
    ]);

    const subtotal = visit.price.toNumber();
    const vatAmount = settings?.vatInInvoices ? +(subtotal * 0.2).toFixed(2) : 0;
    const total = +(subtotal + vatAmount).toFixed(2);

    const customer = visit.property.customer;
    const serviceName = visit.service?.name ?? "Window Cleaning Service";
    const roundPart = visit.round ? ` — ${visit.round.name}` : "";
    const datePart = ` — ${toDateStr(visit.date)}`;

    return {
      invoiceNumber,
      invoiceDate: toDateStr(new Date()),
      visitDate: toDateStr(visit.date),
      dueDate: null,
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
          description: `${serviceName}${roundPart}${datePart}`,
          technicianName: visit.technician?.name ?? null,
          amount: subtotal,
        },
      ],
      subtotal,
      vatAmount,
      total,
      amount: total,
      business: {
        name: settings?.businessName ?? null,
        email: settings?.email ?? null,
      },
    };
  }
}

export function createInvoiceService(prisma: TenantPrismaClient): IInvoiceService {
  return new InvoiceService(prisma);
}

