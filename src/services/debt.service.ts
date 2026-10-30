import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { MessageChannel, PaymentMethod, Prisma, VisitStatus } from "../generated/tenant-client";
import { createMessageService } from "./message.service";
import { getCachedBusinessSettings } from "./settings.service";
import { holdNextVisits, releaseHeldVisits } from "./payment-hold";
import { getInvoiceCheckoutLink } from "../integrations/stripe/checkout";
import {
  FALLBACK_BODIES, TEMPLATE_NAMES, invoiceTemplateVars, loadTemplate, renderTemplate,
} from "./message-templates";

// The 7 tabs the debt board UI shows: the 6 named buckets below, plus
// whatever bucket string doesn't match one of them (the "default"/catch-all
// tab, keyed here as "ALL" for the counts endpoint).
export const DEBT_BUCKETS = [
  "BAD_DEBT",
  "ON_HOLD",
  "FAILED_GC",
  "DUE_BEFORE_CLEAN",
  "SEVEN_DAYS_OVER",
  "FOURTEEN_DAYS_OVER",
  "ALL",
] as const;
export type DebtBucket = (typeof DEBT_BUCKETS)[number];

interface BucketContext {
  failedVisitIds: string[];
  upcomingCustomerIds: string[];
  now: Date;
  sevenDaysAgo: Date;
}

async function computeBucketContext(prisma: TenantPrismaClient): Promise<BucketContext> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);

  const [failedPayments, upcomingVisits] = await Promise.all([
    prisma.payment.findMany({ where: { status: "FAILED", method: "GOCARDLESS" }, select: { visitId: true } }),
    prisma.visit.findMany({
      where: { date: { gte: now, lte: sevenDaysFromNow }, status: { not: VisitStatus.CANCELLED } },
      select: { property: { select: { customerId: true } } },
    }),
  ]);
  const failedVisitIds = [...new Set(failedPayments.map((p) => p.visitId).filter(Boolean) as string[])];
  const upcomingCustomerIds = [...new Set(upcomingVisits.map((v) => v.property.customerId))];

  return { failedVisitIds, upcomingCustomerIds, now, sevenDaysAgo };
}

function buildBucketWhere(
  bucket: string,
  filters: { roundId?: string; paymentMethod?: string; search?: string },
  ctx: BucketContext
): Prisma.InvoiceWhereInput {
  const { roundId, paymentMethod, search } = filters;
  const { failedVisitIds, upcomingCustomerIds, now, sevenDaysAgo } = ctx;

  const customerWhere: Prisma.CustomerWhereInput = {};
  if (paymentMethod) customerWhere.paymentMethod = paymentMethod as PaymentMethod;

  const where: Prisma.InvoiceWhereInput = { status: "SENT", customer: customerWhere };
  if (roundId) where.visit = { property: { roundId } };
  switch (bucket) {
    case "BAD_DEBT":
      customerWhere.badDebt = true;
      break;
    // ON_HOLD is customer-based (onHoldCustomerWhere), never an invoice filter.
    case "FAILED_GC":
      customerWhere.badDebt = false;
      where.visitId = { in: failedVisitIds };
      break;
    case "DUE_BEFORE_CLEAN":
      customerWhere.badDebt = false;
      where.customerId = { in: upcomingCustomerIds };
      break;
    case "SEVEN_DAYS_OVER":
      customerWhere.badDebt = false;
      where.dueDate = { gte: sevenDaysAgo, lt: now };
      break;
    case "FOURTEEN_DAYS_OVER":
      customerWhere.badDebt = false;
      where.dueDate = { lt: sevenDaysAgo };
      break;
    default:
      customerWhere.badDebt = false;
      customerWhere.holdNextClean = false;
      where.customerId = { notIn: upcomingCustomerIds };
      // `visitId` is nullable on Invoice — plain `{ notIn: [...] }` would
      // translate to SQL `NOT IN`, which is NULL (not true) for a NULL
      // visitId, silently dropping standalone invoices with no linked
      // visit. Explicitly allow null alongside "not in the failed set".
      where.AND = [
        { OR: [{ visitId: null }, { visitId: { notIn: failedVisitIds } }] },
        { OR: [{ dueDate: null }, { dueDate: { gte: sevenDaysAgo } }] },
      ];
  }

  if (search) {
    const searchClause: Prisma.InvoiceWhereInput = {
      OR: [
        { customer: { name: { contains: search, mode: "insensitive" } } },
        { visit: { property: { addressLine: { contains: search, mode: "insensitive" } } } },
      ],
    };
    // `where.AND` is only ever set above as an array literal (default bucket
    // case) or left undefined — never a bare object — so no Array.isArray
    // guard is needed here.
    where.AND = where.AND
      ? [...(where.AND as Prisma.InvoiceWhereInput[]), searchClause]
      : [searchClause];
  }

  return where;
}

// ON_HOLD counts customers on hold whatever their invoice status (A3), with
// the board's round / payment-method / search filters applied at customer level.
function onHoldCustomerWhere(filters: { roundId?: string; paymentMethod?: string; search?: string }): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = { holdNextClean: true, badDebt: false };
  if (filters.paymentMethod) where.paymentMethod = filters.paymentMethod as PaymentMethod;
  if (filters.roundId) where.properties = { some: { roundId: filters.roundId } };
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { properties: { some: { addressLine: { contains: filters.search, mode: "insensitive" } } } },
    ];
  }
  return where;
}

// One debt-board row. Invoice buckets give one row per SENT invoice; the
// ON_HOLD bucket gives one row per held customer (A3) — invoice fields then
// describe the customer's oldest SENT invoice (null when none) and `amount`
// is the customer's total outstanding.
type BoardRowBase = {
  invoiceId: string | null;
  invoiceNumber: string | null;
  amount: number;
  dueDate: Date | null;
  customerId: string;
  customerName: string;
  addressLine: string;
  postcode: string | null;
  paymentMethod: string | null;
  badDebt: boolean;
  holdNextClean: boolean;
};

type InvoiceForSend = {
  id: string;
  invoiceNumber: string;
  customerId: string;
  amount: Prisma.Decimal;
  dueDate: Date | null;
  status: string;
  customer: { name: string };
};

export function createDebtService(prisma: TenantPrismaClient) {
  const messages = createMessageService(prisma);

  const loadInvoice = async (invoiceId: string): Promise<InvoiceForSend> => {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { customer: { select: { name: true } } },
    });
    if (!invoice) throw new AppError(404, "Invoice not found");
    return invoice;
  };

  const templateVars = async (invoice: InvoiceForSend, paymentLink?: string) => {
    const settings = await getCachedBusinessSettings(prisma);
    return invoiceTemplateVars({
      customerName: invoice.customer.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount.toNumber(),
      dueDate: invoice.dueDate,
      currency: settings?.currency,
      businessName: settings?.businessName,
      paymentLink,
    });
  };

  return {
    getBoard: async (
      bucket: string,
      roundId?: string,
      paymentMethod?: string,
      page?: number,
      pageSize?: number,
      search?: string
    ) => {
      const pageNum = Math.max(1, page ?? 1);
      const pageSizeNum = Math.min(100, Math.max(1, pageSize ?? 50));
      const skip = (pageNum - 1) * pageSizeNum;

      let total: number;
      let baseRows: BoardRowBase[];
      if (bucket === "ON_HOLD") {
        // Listed per customer so it matches the ON_HOLD count, including held
        // customers with no SENT invoice.
        const customerWhere = onHoldCustomerWhere({ roundId, paymentMethod, search });
        const [count, customers] = await Promise.all([
          prisma.customer.count({ where: customerWhere }),
          prisma.customer.findMany({
            where: customerWhere,
            select: {
              id: true, name: true, paymentMethod: true, badDebt: true, holdNextClean: true,
              properties: { select: { addressLine: true, postcode: true }, orderBy: { createdAt: "asc" }, take: 1 },
              invoices: {
                where: { status: "SENT" },
                select: { id: true, invoiceNumber: true, amount: true, dueDate: true },
                orderBy: { createdAt: "asc" },
              },
            },
            orderBy: [{ holdSince: "asc" }, { createdAt: "asc" }],
            take: pageSizeNum,
            skip,
          }),
        ]);
        total = count;
        baseRows = customers.map((c) => {
          const oldest = c.invoices[0];
          return {
            invoiceId: oldest?.id ?? null,
            invoiceNumber: oldest?.invoiceNumber ?? null,
            amount: c.invoices.reduce((sum, i) => sum + i.amount.toNumber(), 0),
            dueDate: oldest?.dueDate ?? null,
            customerId: c.id,
            customerName: c.name,
            addressLine: c.properties[0]?.addressLine ?? "",
            postcode: c.properties[0]?.postcode ?? null,
            paymentMethod: (c.paymentMethod as string | null) ?? null,
            badDebt: c.badDebt,
            holdNextClean: c.holdNextClean,
          };
        });
      } else {
        const ctx = await computeBucketContext(prisma);
        const where = buildBucketWhere(bucket, { roundId, paymentMethod, search }, ctx);
        const [count, invoices] = await Promise.all([
          prisma.invoice.count({ where }),
          prisma.invoice.findMany({
            where,
            include: {
              customer: { select: { id: true, name: true, email: true, paymentMethod: true, badDebt: true, holdNextClean: true } },
              visit: { select: { date: true, property: { select: { addressLine: true, postcode: true, roundId: true, customerId: true } } } },
            },
            orderBy: { createdAt: "asc" },
            take: pageSizeNum,
            skip,
          }),
        ]);
        total = count;
        baseRows = invoices.map((inv) => ({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount.toNumber(),
          dueDate: inv.dueDate,
          customerId: inv.customerId,
          customerName: inv.customer.name,
          addressLine: inv.visit?.property.addressLine ?? "",
          postcode: inv.visit?.property.postcode ?? null,
          paymentMethod: (inv.customer.paymentMethod as string | null) ?? null,
          badDebt: inv.customer.badDebt,
          holdNextClean: inv.customer.holdNextClean,
        }));
      }

      const customerIds = [...new Set(baseRows.map((r) => r.customerId))];
      const lastMessages = customerIds.length > 0
        ? await prisma.$queryRaw<{ customerId: string; createdAt: Date }[]>`
            SELECT DISTINCT ON ("customerId") "customerId", "createdAt"
            FROM "Message"
            WHERE "customerId" = ANY(${customerIds}) AND "direction" = 'OUTBOUND'
            ORDER BY "customerId", "createdAt" DESC
          `
        : [];
      const lastContactMap = new Map<string, Date>();
      for (const msg of lastMessages) {
        if (msg && msg.customerId) lastContactMap.set(msg.customerId, msg.createdAt);
      }

      const rows = baseRows.map((r) => ({
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        amount: r.amount,
        dueDate: r.dueDate,
        customerId: r.customerId,
        customerName: r.customerName,
        addressLine: r.addressLine,
        postcode: r.postcode,
        paymentMethod: r.paymentMethod,
        lastContactedAt: lastContactMap.get(r.customerId) ?? null,
        badDebt: r.badDebt,
        holdNextClean: r.holdNextClean,
      }));

      return {
        rows,
        pagination: {
          page: pageNum,
          pageSize: pageSizeNum,
          total,
          totalPages: Math.ceil(total / pageSizeNum),
        },
      };
    },
    // A5: payment link = a real Stripe Checkout Session on the tenant's
    // connected account, delivered through GHL. Contact/channel and the GHL
    // connection are checked BEFORE the session is created (D-6), so a
    // request that can't be delivered never orphans a Stripe session.
    sendPaymentLink: async (
      invoiceId: string,
      options: { tenantId: string; channel?: MessageChannel; message?: string }
    ) => {
      const invoice = await loadInvoice(invoiceId);
      if (invoice.status === "PAID" || invoice.status === "VOID") {
        throw new AppError(409, `Invoice is ${invoice.status.toLowerCase()}, so no payment link is needed`, "INVOICE_NOT_PAYABLE");
      }
      const prep = await messages.prepare(invoice.customerId, options.channel);
      const link = await getInvoiceCheckoutLink(prisma, {
        tenantId: options.tenantId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount,
      });
      const template = options.message
        ? { id: null, body: options.message }
        : await loadTemplate(prisma, TEMPLATE_NAMES.PAYMENT_LINK, FALLBACK_BODIES.PAYMENT_LINK);
      const rendered = renderTemplate(template.body, await templateVars(invoice, link.url));
      const body = rendered.includes(link.url) ? rendered : `${rendered}\n\n${link.url}`;
      const sent = await messages.deliver(prep, body, { templateId: template.id });
      return {
        url: link.url,
        messageId: sent.messageId,
        channel: sent.channel,
        // Pre-A5 response fields, kept for one release.
        id: sent.messageId,
        paymentUrl: link.url,
        provider: "stripe" as const,
        expiresAt: link.expiresAt,
      };
    },
    flagHold: async (
      invoiceId: string,
      _flag: boolean,
      options?: { reason?: string | null; date?: Date; notify?: boolean; message?: string }
    ) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({
        where: { id: invoice.customerId },
        data: _flag
          ? { holdNextClean: true, holdReason: options?.reason ?? null, holdSince: options?.date ?? new Date() }
          : { holdNextClean: false, holdReason: null, holdSince: null },
      });
      // A3: the hold is real. Flag (or clear) the customer's next visits.
      const visitsUpdated = await (_flag ? holdNextVisits : releaseHeldVisits)(prisma, updated.id);
      if (_flag && options?.notify) {
        const body = options.message?.trim() || "Your next clean is on hold until this is resolved.";
        await messages.send({ customerId: updated.id, channel: "SMS", body }).catch((err) => {
          console.error(`[debt] hold notify failed for customer ${updated.id}:`, err);
        });
      }
      return {
        customerId: updated.id,
        holdNextClean: updated.holdNextClean,
        holdReason: updated.holdReason,
        holdSince: updated.holdSince,
        visitsUpdated,
      };
    },
    flagBadDebt: async (invoiceId: string, _flag: boolean) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({ where: { id: invoice.customerId }, data: { badDebt: _flag } });
      return { customerId: updated.id, badDebt: updated.badDebt };
    },
    // A5: reminder through GHL. channel omitted = SMS if mobile, else EMAIL;
    // message omitted = the tenant's "Payment Overdue Reminder" template.
    sendReminder: async (invoiceId: string, options: { channel?: MessageChannel; message?: string }) => {
      const invoice = await loadInvoice(invoiceId);
      const prep = await messages.prepare(invoice.customerId, options.channel);
      const template = options.message
        ? { id: null, body: options.message }
        : await loadTemplate(prisma, TEMPLATE_NAMES.PAYMENT_REMINDER, FALLBACK_BODIES.PAYMENT_REMINDER);
      const body = renderTemplate(template.body, await templateVars(invoice));
      const sent = await messages.deliver(prep, body, { templateId: template.id });
      return { id: sent.messageId, messageId: sent.messageId, channel: sent.channel, customerId: invoice.customerId };
    },
    getBucketCounts: async (
      roundId?: string,
      paymentMethod?: string,
      search?: string
    ): Promise<Record<DebtBucket, number>> => {
      const ctx = await computeBucketContext(prisma);
      const entries = await Promise.all(
        DEBT_BUCKETS.map(async (bucket) => {
          const count = bucket === "ON_HOLD"
            ? await prisma.customer.count({ where: onHoldCustomerWhere({ roundId, paymentMethod, search }) })
            : await prisma.invoice.count({ where: buildBucketWhere(bucket, { roundId, paymentMethod, search }, ctx) });
          return [bucket, count] as const;
        })
      );
      return Object.fromEntries(entries) as Record<DebtBucket, number>;
    },
    getKpis: async () => {
      const { failedVisitIds, upcomingCustomerIds } = await computeBucketContext(prisma);

      const [
        totalOutstandingsAgg, badDebtAgg, failedGoCardless, dueBeforeClean, holdNextClean,
        totalOutstandingsCount, badDebtCount,
      ] = await Promise.all([
        prisma.invoice.aggregate({ _sum: { amount: true }, where: { status: "SENT", customer: { badDebt: false } } }),
        prisma.invoice.aggregate({ _sum: { amount: true }, where: { status: "SENT", customer: { badDebt: true } } }),
        prisma.invoice.count({ where: { status: "SENT", customer: { badDebt: false }, visitId: { in: failedVisitIds } } }),
        prisma.invoice.count({ where: { status: "SENT", customer: { badDebt: false }, customerId: { in: upcomingCustomerIds } } }),
        // A3: customers on hold, whatever their invoice status.
        prisma.customer.count({ where: { holdNextClean: true, badDebt: false } }),
        // GAP-031: distinct customers behind each total.
        prisma.customer.count({ where: { badDebt: false, invoices: { some: { status: "SENT" } } } }),
        prisma.customer.count({ where: { badDebt: true, invoices: { some: { status: "SENT" } } } }),
      ]);

      const totalOutstandings = Number(totalOutstandingsAgg._sum.amount ?? 0);
      const badDebt = Number(badDebtAgg._sum.amount ?? 0);

      return {
        totalOutstandings, totalOutstandingsCount, badDebt, badDebtCount,
        failedGoCardless, dueBeforeClean, holdNextClean,
      };
    },
    // Detail for one invoice — the fields the debt board's row doesn't carry
    // (phone/email/round/next visit/mandate/recent visits), so the debt
    // detail panel stops showing "—" for all of them.
    getInvoiceDetail: async (invoiceId: string) => {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          customer: {
            select: {
              id: true, name: true, phone: true, email: true,
              gocardlessMandateId: true, gocardlessMandateStatus: true,
            },
          },
          visit: { select: { property: { select: { roundId: true, round: { select: { name: true } } } } } },
        },
      });
      if (!invoice) throw new AppError(404, "Invoice not found");

      const [nextVisit, recentVisits] = await Promise.all([
        prisma.visit.findFirst({
          where: {
            property: { customerId: invoice.customerId },
            date: { gte: new Date() },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
          },
          orderBy: { date: "asc" },
          select: { date: true },
        }),
        prisma.visit.findMany({
          where: { property: { customerId: invoice.customerId }, status: { not: VisitStatus.CANCELLED } },
          orderBy: { date: "desc" },
          take: 5,
          select: { id: true, date: true, status: true, price: true },
        }),
      ]);

      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount.toNumber(),
        dueDate: invoice.dueDate,
        status: invoice.status,
        customerId: invoice.customerId,
        customerName: invoice.customer.name,
        phone: invoice.customer.phone,
        email: invoice.customer.email,
        roundId: invoice.visit?.property.roundId ?? null,
        roundName: invoice.visit?.property.round?.name ?? null,
        nextVisitDate: nextVisit?.date ?? null,
        mandateId: invoice.customer.gocardlessMandateId,
        mandateStatus: invoice.customer.gocardlessMandateStatus,
        recentVisits: recentVisits.map((v) => ({
          visitId: v.id,
          date: v.date,
          status: v.status,
          amount: v.price.toNumber(),
        })),
      };
    },
  };
}
