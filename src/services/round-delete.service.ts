import { VisitStatus } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { tenantToday } from "./business-time";
import { cancelPendingVisitMessages } from "./visit-reschedule";

// Round delete (2026-11-25, owner rules in docs/PLAN_2026-11-25_rounds-edit-delete-move.md):
// - upcoming = the round's SCHEDULED/SKIPPED visits dated today (tenant-local) or later: deleted.
// - every other visit of the round (completed, in progress, cancelled, older unfinished) is kept as history, roundId = null.
// - the round's properties are unassigned (roundId = null, round technician split cleared); service plans stay ACTIVE.
// - blocked (409) while any TechnicianEmergency references the round, or any upcoming visit carries financial /
//   evidence records (invoice, invoice line, payment, photo, issue, technician incident, chat message) — nothing is lost.

export interface RoundDeletePreview {
  propertyCount: number;
  upcomingVisitCount: number;
  detachedVisitCount: number;
  emergencyCount: number;
  attachedVisitCount: number;
  canDelete: boolean;
}

export interface RoundDeleteResult {
  roundName: string;
  deleted: true;
  unassignedProperties: number;
  deletedVisits: number;
  detachedVisits: number;
}

const UPCOMING_STATUSES = [VisitStatus.SCHEDULED, VisitStatus.SKIPPED];

type Db = Pick<
  TenantPrismaClient,
  "round" | "property" | "visit" | "technicianEmergency" | "chatMessage" | "chatRead" | "integrationOutbox"
>;

const upcomingWhere = (roundId: string, today: Date) => ({
  roundId,
  status: { in: UPCOMING_STATUSES },
  date: { gte: today },
});

async function loadImpact(db: Db, roundId: string, today: Date) {
  const round = await db.round.findUnique({ where: { id: roundId }, select: { id: true, name: true } });
  if (!round) throw new AppError(404, "Round not found");

  const [propertyCount, emergencyCount, totalVisits, upcoming] = await Promise.all([
    db.property.count({ where: { roundId } }),
    db.technicianEmergency.count({ where: { roundId } }),
    db.visit.count({ where: { roundId } }),
    db.visit.findMany({
      where: upcomingWhere(roundId, today),
      select: {
        id: true,
        invoice: { select: { id: true } },
        invoiceLine: { select: { id: true } },
        payment: { select: { id: true } },
        _count: { select: { photos: true, issues: true, incidents: true } },
      },
    }),
  ]);
  const upcomingIds = upcoming.map((v) => v.id);

  // ChatMessage.visitId is a plain column (no relation), so it is looked up separately.
  const chatVisitIds = new Set<string | null>();
  if (upcomingIds.length > 0) {
    const rows = await db.chatMessage.findMany({
      where: { visitId: { in: upcomingIds } },
      select: { visitId: true },
      distinct: ["visitId"],
    });
    for (const r of rows) chatVisitIds.add(r.visitId);
  }

  const attachedVisitCount = upcoming.filter(
    (v) =>
      v.invoice !== null ||
      v.invoiceLine !== null ||
      v.payment !== null ||
      v._count.photos > 0 ||
      v._count.issues > 0 ||
      v._count.incidents > 0 ||
      chatVisitIds.has(v.id)
  ).length;

  return {
    round,
    upcomingIds,
    preview: {
      propertyCount,
      upcomingVisitCount: upcomingIds.length,
      detachedVisitCount: totalVisits - upcomingIds.length,
      emergencyCount,
      attachedVisitCount,
      canDelete: emergencyCount === 0 && attachedVisitCount === 0,
    } satisfies RoundDeletePreview,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function createRoundDeleteService(prisma: TenantPrismaClient) {
  return {
    /** What DELETE /rounds/:id would do, and whether it is allowed. Read-only. */
    preview: async (roundId: string): Promise<RoundDeletePreview> => {
      const today = await tenantToday(prisma);
      return (await loadImpact(prisma, roundId, today)).preview;
    },

    /** Deletes the round in one transaction; the blocking rules are checked again inside it. */
    deleteRound: async (roundId: string): Promise<RoundDeleteResult> => {
      const today = await tenantToday(prisma);
      return prisma.$transaction(async (tx) => {
        const { round, upcomingIds, preview } = await loadImpact(tx, roundId, today);
        if (preview.emergencyCount > 0) {
          throw new AppError(
            409,
            `This round has ${plural(preview.emergencyCount, "emergency record", "emergency records")} and cannot be deleted.`,
            "ROUND_HAS_EMERGENCIES"
          );
        }
        if (preview.attachedVisitCount > 0) {
          throw new AppError(
            409,
            `${plural(preview.attachedVisitCount, "upcoming visit has", "upcoming visits have")} invoices, payments, photos, issues or other records attached, so the round cannot be deleted.`,
            "ROUND_HAS_ATTACHED_VISITS"
          );
        }

        await cancelPendingVisitMessages(tx, upcomingIds, "Round deleted");
        const deleted =
          upcomingIds.length > 0
            ? await tx.visit.deleteMany({ where: { id: { in: upcomingIds }, ...upcomingWhere(roundId, today) } })
            : { count: 0 };
        const detached = await tx.visit.updateMany({ where: { roundId }, data: { roundId: null } });
        const properties = await tx.property.updateMany({
          where: { roundId },
          data: { roundId: null, assignedTechnicianId: null },
        });
        // ChatRead has no FK to Round; drop the read markers with the round. RoundTechnician and ChatMessage cascade.
        await tx.chatRead.deleteMany({ where: { roundId } });
        await tx.round.delete({ where: { id: roundId } });

        return {
          roundName: round.name,
          deleted: true as const,
          unassignedProperties: properties.count,
          deletedVisits: deleted.count,
          detachedVisits: detached.count,
        };
      });
    },
  };
}
