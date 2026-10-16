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
      const where: Record<string, unknown> = {};
      if (type) where.type = type;
      const logs = await prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return logs.map((l) => ({
        id: l.id,
        type: l.type,
        message: l.message,
        actorRole: l.actorRole ?? null,
        createdAt: l.createdAt,
      }));
    },
    getVisits: async (period: string, status?: string) => {
      const range = periodRange(period as Period);
      const where: Record<string, unknown> = { date: range };
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
      return visits.map((v) => ({
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
      // One grouped row per (technicianId, status) combination within the period,
      // with counts/sum computed in SQL instead of a full-row findMany + JS reduce.
      const groups = await prisma.visit.groupBy({
        by: ["technicianId", "status"],
        where: { date: range, technicianId: { not: null } },
        _count: true,
        _sum: { price: true },
      });

      const technicianIds = Array.from(
        new Set(
          (groups as Array<{ technicianId: string | null }>)
            .map((g) => g.technicianId)
            .filter((id): id is string => !!id)
        )
      );
      const technicians = technicianIds.length > 0
        ? await prisma.technician.findMany({
            where: { id: { in: technicianIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const techInfo = new Map(technicians.map((t) => [t.id, t]));

      const map = new Map<string, { name: string | null; email: string | null; completed: number; skipped: number; revenue: number }>();
      for (const g of groups as Array<{
        technicianId: string | null;
        status: string;
        _count: number;
        _sum: { price: { toNumber(): number } | null };
      }>) {
        if (!g.technicianId) continue;
        const info = techInfo.get(g.technicianId);
        const existing = map.get(g.technicianId) ?? {
          name: info?.name ?? null,
          email: info?.email ?? null,
          completed: 0,
          skipped: 0,
          revenue: 0,
        };
        if (g.status === "COMPLETED") {
          existing.completed += g._count;
          existing.revenue += g._sum.price?.toNumber() ?? 0;
        }
        if (g.status === "SKIPPED") existing.skipped += g._count;
        map.set(g.technicianId, existing);
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
    getRevenue: async (period: string) => {
      const range = periodRange(period as Period);
      // Daily-granularity grouping requires date truncation, which Prisma's groupBy
      // can't do — use raw SQL (Visit.date is "timestamp(3) without time zone", so
      // date_trunc('day', ...) truncates the same UTC wall-clock value the old JS
      // code bucketed via date.toISOString().slice(0, 10)).
      const rows = await prisma.$queryRaw<{ day: Date; amount: unknown }[]>`
        SELECT date_trunc('day', "date") AS day,
               COALESCE(SUM("price"), 0) AS amount
        FROM "Visit"
        WHERE "date" >= ${range.gte} AND "date" <= ${range.lte} AND "status" = 'COMPLETED'
        GROUP BY 1 ORDER BY 1
      `;
      return rows.map((r) => ({
        date: new Date(r.day).toISOString().slice(0, 10),
        amount: Number(r.amount),
      }));
    },
    getSummary: async (period: string) => {
      const range = periodRange(period as Period);
      const [visitAgg, roundGroups, invoiceAgg] = await Promise.all([
        prisma.visit.aggregate({
          _count: true,
          _sum: { price: true },
          where: { date: range, status: "COMPLETED" },
        }),
        // completedRounds is a distinct-round count, not a sum — groupBy + length
        prisma.visit.groupBy({
          by: ["roundId"],
          where: { date: range, status: "COMPLETED", roundId: { not: null } },
        }),
        prisma.invoice.aggregate({
          _sum: { amount: true },
          where: { status: "SENT" },
        }),
      ]);
      return {
        totalRevenue: visitAgg._sum.price?.toNumber() ?? 0,
        completedVisits: visitAgg._count as unknown as number,
        completedRounds: roundGroups.length,
        undonePayments: invoiceAgg._sum.amount?.toNumber() ?? 0,
      };
    },
  };
}
