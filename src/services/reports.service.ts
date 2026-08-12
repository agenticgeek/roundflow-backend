import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";

type Period = "today" | "last7" | "last30";

function periodRange(period: Period): { gte: Date; lte: Date } {
  const now = new Date();
  const lte = now;
  const gte = new Date(now);
  if (period === "today") gte.setHours(0, 0, 0, 0);
  else if (period === "last7") gte.setDate(gte.getDate() - 7);
  else gte.setDate(gte.getDate() - 30);
  return { gte, lte };
}

export function createReportsService(prisma: TenantPrismaClient) {
  return {
    logActivity: async (type: string, message: string, actorId?: string, actorRole?: string) => {
      await prisma.activityLog.create({ data: { type, message, actorId: actorId ?? null, actorRole: actorRole ?? null } });
    },
    getActivity: async (type?: string) => {
      const where: any = {};
      if (type) where.type = type;
      const logs = await prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return (logs as any[]).map((l) => ({
        id: l.id,
        type: l.type,
        message: l.message,
        actorRole: l.actorRole ?? null,
        createdAt: l.createdAt,
      }));
    },
    getVisits: async (period: string, status?: string) => {
      const range = periodRange(period as Period);
      const where: any = { date: range };
      if (status) where.status = status;
      const visits = await prisma.visit.findMany({
        where,
        select: {
          id: true, date: true, status: true, price: true,
          property: { select: { addressLine: true, postcode: true } },
          round: { select: { name: true } },
          technician: { select: { name: true } },
        },
        orderBy: { date: "desc" },
      });
      return (visits as any[]).map((v) => ({
        visitId: v.id,
        date: v.date,
        property: v.property?.addressLine ?? "",
        postcode: v.property?.postcode ?? null,
        round: v.round?.name ?? null,
        technician: v.technician?.name ?? null,
        status: v.status,
        amount: v.price.toNumber(),
      }));
    },
    getTechnicians: async (period: string) => {
      const range = periodRange(period as Period);
      const visits = await prisma.visit.findMany({
        where: { date: range, technicianId: { not: null } },
        select: { technicianId: true, status: true, price: true, technician: { select: { id: true, name: true, email: true } } },
      });
      const map = new Map<string, { name: string | null; email: string | null; completed: number; skipped: number; revenue: number }>();
      for (const v of visits as any[]) {
        if (!v.technicianId) continue;
        const existing = map.get(v.technicianId) ?? { name: v.technician?.name ?? null, email: v.technician?.email ?? null, completed: 0, skipped: 0, revenue: 0 };
        if (v.status === "COMPLETED") { existing.completed++; existing.revenue += v.price.toNumber(); }
        if (v.status === "SKIPPED") existing.skipped++;
        map.set(v.technicianId, existing);
      }
      return Array.from(map.entries()).map(([id, s]) => ({
        technicianId: id,
        name: s.name,
        email: s.email,
        completed: s.completed,
        skipped: s.skipped,
        efficiency: s.completed + s.skipped > 0 ? Math.round((s.completed / (s.completed + s.skipped)) * 100) : 0,
        revenueImpact: s.revenue,
      }));
    },
    getRevenue: async (period: string, _granularity: string) => {
      const range = periodRange(period as Period);
      const visits = await prisma.visit.findMany({
        where: { date: range, status: "COMPLETED" },
        select: { date: true, price: true },
        orderBy: { date: "asc" },
      });
      // Group by date string (daily granularity for now)
      const map = new Map<string, number>();
      for (const v of visits as any[]) {
        const key = (v.date as Date).toISOString().slice(0, 10);
        map.set(key, (map.get(key) ?? 0) + v.price.toNumber());
      }
      return Array.from(map.entries()).map(([date, amount]) => ({ date, amount }));
    },
    getSummary: async (period: string) => {
      const range = periodRange(period as Period);
      const [visits, sentInvoices] = await Promise.all([
        prisma.visit.findMany({
          where: { date: range },
          select: { price: true, status: true, roundId: true },
        }),
        prisma.invoice.findMany({
          where: { status: "SENT" },
          select: { amount: true },
        }),
      ]);
      const completed = visits.filter((v: any) => v.status === "COMPLETED");
      const totalRevenue = completed.reduce((s: number, v: any) => s + v.price.toNumber(), 0);
      const completedVisits = completed.length;
      const completedRounds = new Set(completed.map((v: any) => v.roundId).filter(Boolean)).size;
      const undonePayments = sentInvoices.reduce((s: number, i: any) => s + i.amount.toNumber(), 0);
      return { totalRevenue, completedVisits, completedRounds, undonePayments };
    },
  };
}
