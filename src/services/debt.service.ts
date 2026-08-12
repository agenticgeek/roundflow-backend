import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";

export function createDebtService(prisma: TenantPrismaClient) {
  return {
    getBoard: async (bucket: string, roundId?: string, paymentMethod?: string) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);

      const invoices = await prisma.invoice.findMany({
        where: { status: "SENT" },
        include: {
          customer: { select: { id: true, name: true, email: true, paymentMethod: true, badDebt: true, holdNextClean: true } },
          visit: { select: { date: true, property: { select: { addressLine: true, postcode: true, roundId: true, customerId: true } } } },
        },
        orderBy: { createdAt: "asc" },
      });

      const customerIds = [...new Set(invoices.map((i: any) => i.customerId as string))];
      const lastMessages = await Promise.all(
        customerIds.map((cid: string) =>
          prisma.message.findFirst({ where: { customerId: cid, direction: "OUTBOUND" }, orderBy: { createdAt: "desc" }, select: { customerId: true, createdAt: true } })
        )
      );
      const lastContactMap = new Map<string, Date>();
      for (const msg of lastMessages) {
        if (msg && msg.customerId) lastContactMap.set(msg.customerId, msg.createdAt);
      }

      const [failedPayments, upcomingVisits] = await Promise.all([
        prisma.payment.findMany({ where: { status: "FAILED", method: "GOCARDLESS" }, select: { visitId: true } }),
        prisma.visit.findMany({ where: { date: { gte: now, lte: sevenDaysFromNow } }, select: { property: { select: { customerId: true } } } }),
      ]);
      const failedVisitIds = new Set(failedPayments.map((p: any) => p.visitId).filter(Boolean));
      const upcomingCustomerIds = new Set(upcomingVisits.map((v: any) => v.property.customerId));

      const toItem = (inv: any) => ({
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
      });

      return invoices
        .filter((inv: any) => {
          if (roundId && inv.visit?.property.roundId !== roundId) return false;
          if (paymentMethod && inv.customer.paymentMethod !== paymentMethod) return false;
          switch (bucket) {
            case "BAD_DEBT": return inv.customer.badDebt;
            case "ON_HOLD": return !inv.customer.badDebt && inv.customer.holdNextClean;
            case "FAILED_GC": return !inv.customer.badDebt && failedVisitIds.has(inv.visitId);
            case "DUE_BEFORE_CLEAN": return !inv.customer.badDebt && upcomingCustomerIds.has(inv.customerId);
            case "SEVEN_DAYS_OVER": return !inv.customer.badDebt && inv.dueDate !== null && inv.dueDate >= sevenDaysAgo && inv.dueDate < now;
            case "FOURTEEN_DAYS_OVER": return !inv.customer.badDebt && inv.dueDate !== null && inv.dueDate < sevenDaysAgo;
            default: return !inv.customer.badDebt && !inv.customer.holdNextClean && !failedVisitIds.has(inv.visitId) && !upcomingCustomerIds.has(inv.customerId) && (inv.dueDate === null || inv.dueDate >= sevenDaysAgo);
          }
        })
        .map(toItem);
    },
    sendPaymentLink: async (invoiceId: string, _message: string) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: { select: { id: true, name: true, email: true } } } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (!(invoice as any).customer.email) throw new AppError(400, "Customer has no email address");
      const settings = await prisma.businessSettings.findFirst({ select: { businessName: true, email: true } });
      const link = `https://pay.roundflow.app/i/${(invoice as any).invoiceNumber}`;
      const body = `${_message}\n\n${link}`;
      const msg = await prisma.message.create({ data: { channel: "EMAIL", direction: "OUTBOUND", body, customerId: (invoice as any).customerId, sentAt: new Date() } });
      void settings;
      return { id: msg.id };
    },
    flagHold: async (invoiceId: string, _flag: boolean) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({ where: { id: (invoice as any).customerId }, data: { holdNextClean: _flag } });
      return { customerId: updated.id, holdNextClean: (updated as any).holdNextClean };
    },
    flagBadDebt: async (invoiceId: string, _flag: boolean) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      const updated = await prisma.customer.update({ where: { id: (invoice as any).customerId }, data: { badDebt: _flag } });
      return { customerId: updated.id, badDebt: updated.badDebt };
    },
    sendReminder: async (invoiceId: string, channel: string, _message: string) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: { select: { id: true, name: true, email: true } } } });
      if (!invoice) throw new AppError(404, "Invoice not found");
      if (channel === "EMAIL" && !(invoice as any).customer.email) throw new AppError(400, "Customer has no email address");
      const msg = await prisma.message.create({ data: { channel: channel as any, direction: "OUTBOUND", body: _message, customerId: (invoice as any).customerId, sentAt: new Date() } });
      return { id: msg.id };
    },
    getKpis: async () => {
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);
      const [invoices, failedPayments, upcomingVisits] = await Promise.all([
        prisma.invoice.findMany({
          where: { status: "SENT" },
          include: { customer: { select: { badDebt: true, holdNextClean: true } } },
        }),
        prisma.payment.findMany({
          where: { status: "FAILED", method: "GOCARDLESS" },
          select: { visitId: true },
        }),
        prisma.visit.findMany({
          where: { date: { gte: now, lte: sevenDaysFromNow } },
          select: { property: { select: { customerId: true } } },
        }),
      ]);
      const failedVisitIds = new Set(failedPayments.map((p: any) => p.visitId).filter(Boolean));
      const upcomingCustomerIds = new Set(upcomingVisits.map((v: any) => v.property.customerId));
      const totalOutstandings = invoices
        .filter((i: any) => !i.customer.badDebt)
        .reduce((sum: number, i: any) => sum + i.amount.toNumber(), 0);
      const badDebt = invoices
        .filter((i: any) => i.customer.badDebt)
        .reduce((sum: number, i: any) => sum + i.amount.toNumber(), 0);
      const failedGoCardless = invoices.filter((i: any) => !i.customer.badDebt && failedVisitIds.has(i.visitId)).length;
      const dueBeforeClean = invoices.filter((i: any) => !i.customer.badDebt && upcomingCustomerIds.has(i.customerId)).length;
      const holdCustomers = new Set(invoices.filter((i: any) => !i.customer.badDebt && i.customer.holdNextClean).map((i: any) => i.customerId));
      return { totalOutstandings, badDebt, failedGoCardless, dueBeforeClean, holdNextClean: holdCustomers.size };
    },
  };
}
