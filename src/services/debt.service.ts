import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { MessageChannel, PaymentMethod, Prisma } from "../generated/tenant-client";

export function createDebtService(prisma: TenantPrismaClient) {
  return {
    getBoard: async (bucket: string, roundId?: string, paymentMethod?: string, page?: number, pageSize?: number) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);
      const pageNum = Math.max(1, page ?? 1);
      const pageSizeNum = Math.min(100, Math.max(1, pageSize ?? 50));
      const skip = (pageNum - 1) * pageSizeNum;

      const [failedPayments, upcomingVisits] = await Promise.all([
        prisma.payment.findMany({ where: { status: "FAILED", method: "GOCARDLESS" }, select: { visitId: true } }),
        prisma.visit.findMany({ where: { date: { gte: now, lte: sevenDaysFromNow } }, select: { property: { select: { customerId: true } } } }),
      ]);
      const failedVisitIds = [...new Set(failedPayments.map((p) => p.visitId).filter(Boolean) as string[])];
      const upcomingCustomerIds = [...new Set(upcomingVisits.map((v) => v.property.customerId))];

      const customerWhere: Prisma.CustomerWhereInput = {};
      if (paymentMethod) customerWhere.paymentMethod = paymentMethod as PaymentMethod;

      const where: Prisma.InvoiceWhereInput = { status: "SENT", customer: customerWhere };
      if (roundId) where.visit = { property: { roundId } };
      switch (bucket) {
        case "BAD_DEBT":
          customerWhere.badDebt = true;
          break;
        case "ON_HOLD":
          customerWhere.badDebt = false;
          customerWhere.holdNextClean = true;
          break;
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

      const [total, invoices] = await Promise.all([
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

      const customerIds = [...new Set(invoices.map((i) => i.customerId))];
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

      const rows = invoices.map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount.toNumber(),
        dueDate: inv.dueDate,
        customerId: inv.customerId,
        customerName: inv.customer.name,
        addressLine: inv.visit?.property.addressLine ?? "",
        postcode: inv.visit?.property.postcode ?? null,
        paymentMethod: (inv.customer.paymentMethod as string | null) ?? null,
        lastContactedAt: lastContactMap.get(inv.customerId) ?? null,
        badDebt: inv.customer.badDebt,
        holdNextClean: inv.customer.holdNextClean,
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
    sendPaymentLink: async (invoiceId: string, _message: string, overrideUrl?: string) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: { select: { id: true, name: true, email: true } } } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (!invoice.customer.email) throw new AppError(400, "Customer has no email address");
      const link = overrideUrl ?? `https://pay.roundflow.app/i/${invoice.invoiceNumber}`;
      const body = `${_message}\n\n${link}`;
      const msg = await prisma.message.create({ data: { channel: "EMAIL", direction: "OUTBOUND", body, customerId: invoice.customerId, sentAt: new Date() } });
      return { id: msg.id, paymentUrl: link };
    },
    flagHold: async (invoiceId: string, _flag: boolean) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({ where: { id: invoice.customerId }, data: { holdNextClean: _flag } });
      return { customerId: updated.id, holdNextClean: updated.holdNextClean };
    },
    flagBadDebt: async (invoiceId: string, _flag: boolean) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({ where: { id: invoice.customerId }, data: { badDebt: _flag } });
      return { customerId: updated.id, badDebt: updated.badDebt };
    },
    sendReminder: async (invoiceId: string, channel: string, _message: string) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: { select: { id: true, name: true, email: true } } } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (channel === "EMAIL" && !invoice.customer.email) throw new AppError(400, "Customer has no email address");
      const msg = await prisma.message.create({ data: { channel: channel as MessageChannel, direction: "OUTBOUND", body: _message, customerId: invoice.customerId, sentAt: new Date() } });
      return { id: msg.id };
    },
    getKpis: async () => {
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);
      const [failedPayments, upcomingVisits] = await Promise.all([
        prisma.payment.findMany({ where: { status: "FAILED", method: "GOCARDLESS" }, select: { visitId: true } }),
        prisma.visit.findMany({ where: { date: { gte: now, lte: sevenDaysFromNow } }, select: { property: { select: { customerId: true } } } }),
      ]);
      const failedVisitIds = [...new Set(failedPayments.map((p) => p.visitId).filter(Boolean) as string[])];
      const upcomingCustomerIds = [...new Set(upcomingVisits.map((v) => v.property.customerId))];

      const [totalOutstandingsAgg, badDebtAgg, failedGoCardless, dueBeforeClean, holdCustomers] = await Promise.all([
        prisma.invoice.aggregate({ _sum: { amount: true }, where: { status: "SENT", customer: { badDebt: false } } }),
        prisma.invoice.aggregate({ _sum: { amount: true }, where: { status: "SENT", customer: { badDebt: true } } }),
        prisma.invoice.count({ where: { status: "SENT", customer: { badDebt: false }, visitId: { in: failedVisitIds } } }),
        prisma.invoice.count({ where: { status: "SENT", customer: { badDebt: false }, customerId: { in: upcomingCustomerIds } } }),
        prisma.invoice.findMany({
          where: { status: "SENT", customer: { badDebt: false, holdNextClean: true } },
          distinct: ["customerId"],
          select: { customerId: true },
        }),
      ]);

      const totalOutstandings = Number(totalOutstandingsAgg._sum.amount ?? 0);
      const badDebt = Number(badDebtAgg._sum.amount ?? 0);

      return { totalOutstandings, badDebt, failedGoCardless, dueBeforeClean, holdNextClean: holdCustomers.length };
    },
  };
}
