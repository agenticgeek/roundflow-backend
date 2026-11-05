import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { prisma as publicPrisma } from "../lib/prisma";

// Unknown values fall back to last30 (the frontend handoff documents this).
type Period = "today" | "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear";

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResult<T> {
  rows: T[];
  pagination: Pagination;
}

export function periodRange(period: Period, now: Date = new Date()): { gte: Date; lte: Date } {
  const gte = new Date(now);
  switch (period) {
    case "today":
      gte.setHours(0, 0, 0, 0);
      return { gte, lte: now };
    case "last7":
      gte.setDate(gte.getDate() - 7);
      return { gte, lte: now };
    case "last90":
      gte.setDate(gte.getDate() - 90);
      return { gte, lte: now };
    case "thisMonth":
      return { gte: new Date(now.getFullYear(), now.getMonth(), 1), lte: now };
    case "lastMonth":
      return {
        gte: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        lte: new Date(new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1),
      };
    case "thisYear":
      return { gte: new Date(now.getFullYear(), 0, 1), lte: now };
    default:
      gte.setDate(gte.getDate() - 30);
      return { gte, lte: now };
  }
}

// A4: CANCELLED visits (paused plans etc.) never count in reports unless the
// caller explicitly filters for them.
function visitStatusWhere(status?: string) {
  return status ? status : { not: "CANCELLED" };
}

function paginate(page: number | undefined, pageSize: number | undefined): { pageNum: number; pageSizeNum: number; skip: number } {
  const pageNum = Math.max(1, page ?? 1);
  const pageSizeNum = Math.min(100, Math.max(1, pageSize ?? 50));
  return { pageNum, pageSizeNum, skip: (pageNum - 1) * pageSizeNum };
}

function toPagination(pageNum: number, pageSizeNum: number, total: number): Pagination {
  return { page: pageNum, pageSize: pageSizeNum, total, totalPages: Math.ceil(total / pageSizeNum) };
}

export interface TechnicianReportRow {
  technicianId: string;
  name: string | null;
  email: string | null;
  completed: number;
  skipped: number;
  efficiency: number;
  revenueImpact: number;
}

// Shared by getTechnicians (paginated) and getTechniciansExport (full set) —
// builds the complete, deterministically-ordered technician row list for the
// period; callers decide whether to slice it.
async function buildTechnicianRows(prisma: TenantPrismaClient, period: Period): Promise<TechnicianReportRow[]> {
  const range = periodRange(period);
  // One grouped row per (technicianId, status) combination within the period,
  // with counts/sum computed in SQL instead of a full-row findMany + JS reduce.
  const groups = await prisma.visit.groupBy({
    by: ["technicianId", "status"],
    where: { date: range, technicianId: { not: null }, status: { not: "CANCELLED" } },
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
  return Array.from(map.entries())
    .map(([id, s]) => ({
      technicianId: id,
      name: s.name,
      email: s.email,
      completed: s.completed,
      skipped: s.skipped,
      efficiency: s.completed + s.skipped > 0 ? Math.round((s.completed / (s.completed + s.skipped)) * 100) : 0,
      revenueImpact: s.revenue,
    }))
    // Deterministic order so pagination is stable across pages (the
    // source Map's insertion order depends on groupBy's row order).
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.technicianId.localeCompare(b.technicianId));
}

export function createReportsService(prisma: TenantPrismaClient) {
  return {
    logActivity: async (type: string, message: string, actorId?: string, actorRole?: string) => {
      await prisma.activityLog.create({ data: { type, message, actorId: actorId ?? null, actorRole: actorRole ?? null } });
    },
    getActivity: async (
      type?: string,
      from?: Date,
      to?: Date,
      page?: number,
      pageSize?: number
    ): Promise<PaginatedResult<{ id: string; type: string; message: string; actorRole: string | null; actorName: string | null; createdAt: Date }>> => {
      const { pageNum, pageSizeNum, skip } = paginate(page, pageSize);
      const where: Record<string, unknown> = {};
      if (type) where.type = type;
      if (from || to) {
        where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      }
      const [total, logs] = await Promise.all([
        prisma.activityLog.count({ where }),
        prisma.activityLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: pageSizeNum,
          skip,
        }),
      ]);

      // ActivityLog.actorId references Profile.id in the control-plane
      // (public) schema, not this tenant schema — resolved with a second,
      // cross-schema lookup rather than a Prisma relation/include.
      const actorIds = [...new Set(logs.map((l) => l.actorId).filter((id): id is string => !!id))];
      const actors = actorIds.length > 0
        ? await publicPrisma.profile.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
        : [];
      const actorNameMap = new Map(actors.map((a) => [a.id, a.name]));

      return {
        rows: logs.map((l) => ({
          id: l.id,
          type: l.type,
          message: l.message,
          actorRole: l.actorRole ?? null,
          actorName: l.actorId ? actorNameMap.get(l.actorId) ?? null : null,
          createdAt: l.createdAt,
        })),
        pagination: toPagination(pageNum, pageSizeNum, total),
      };
    },
    getVisits: async (
      period: string,
      status?: string,
      page?: number,
      pageSize?: number
    ): Promise<PaginatedResult<{ visitId: string; date: Date; property: string; postcode: string | null; round: string | null; technician: string | null; status: string; amount: number }>> => {
      const { pageNum, pageSizeNum, skip } = paginate(page, pageSize);
      const range = periodRange(period as Period);
      const where: Record<string, unknown> = { date: range, status: visitStatusWhere(status) };
      const [total, visits] = await Promise.all([
        prisma.visit.count({ where }),
        prisma.visit.findMany({
          where,
          select: {
            id: true, date: true, status: true, price: true,
            property: { select: { addressLine: true, postcode: true } },
            round: { select: { name: true } },
            technician: { select: { name: true } },
          },
          orderBy: { date: "desc" },
          take: pageSizeNum,
          skip,
        }),
      ]);
      return {
        rows: visits.map((v) => ({
          visitId: v.id,
          date: v.date,
          property: v.property?.addressLine ?? "",
          postcode: v.property?.postcode ?? null,
          round: v.round?.name ?? null,
          technician: v.technician?.name ?? null,
          status: v.status,
          amount: v.price.toNumber(),
        })),
        pagination: toPagination(pageNum, pageSizeNum, total),
      };
    },
    // Full (unpaginated) visit rows for the period — used by CSV export,
    // which must export everything, not just the UI's current page.
    getVisitsExport: async (period: string, status?: string) => {
      const range = periodRange(period as Period);
      const where: Record<string, unknown> = { date: range, status: visitStatusWhere(status) };
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
    getTechnicians: async (period: string, page?: number, pageSize?: number) => {
      const rows = await buildTechnicianRows(prisma, period as Period);
      const { pageNum, pageSizeNum, skip } = paginate(page, pageSize);
      return {
        rows: rows.slice(skip, skip + pageSizeNum),
        pagination: toPagination(pageNum, pageSizeNum, rows.length),
      };
    },
    // Full (unpaginated) technician rows for the period — used by CSV export.
    getTechniciansExport: async (period: string) => buildTechnicianRows(prisma, period as Period),
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
