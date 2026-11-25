import { Prisma, VisitStatus } from "../generated/tenant-client";
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
// - closures naming the round lose its id. One that named only this round would widen to "all rounds" with an empty
//   list, so instead it is deleted if it has not ended (end date today or later), or kept unchanged as history if it has.
//   Closures carry no FK state: applied MOVE/SKIP results live on the visits, so deleting the row is safe (as DELETE /closures/:id).

export interface RoundDeletePreview {
  propertyCount: number;
  upcomingVisitCount: number;
  detachedVisitCount: number;
  emergencyCount: number;
  attachedVisitCount: number;
  canDelete: boolean;
  closuresToRemove: number;
  closuresToUpdate: number;
}

export interface RoundDeleteResult {
  roundName: string;
  deleted: true;
  unassignedProperties: number;
  deletedVisits: number;
  detachedVisits: number;
  removedClosures: number;
  updatedClosures: number;
}

const UPCOMING_STATUSES = [VisitStatus.SCHEDULED, VisitStatus.SKIPPED];

type Db = Pick<
  TenantPrismaClient,
  "round" | "property" | "visit" | "technicianEmergency" | "chatMessage" | "chatRead" | "integrationOutbox" | "businessClosure"
>;

const upcomingWhere = (roundId: string, today: Date) => ({
  roundId,
  status: { in: UPCOMING_STATUSES },
  date: { gte: today },
});

async function loadImpact(db: Db, roundId: string, today: Date) {
  const round = await db.round.findUnique({ where: { id: roundId }, select: { id: true, name: true } });
  if (!round) throw new AppError(404, "Round not found");

  const [propertyCount, emergencyCount, totalVisits, upcoming, closures] = await Promise.all([
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
    db.businessClosure.findMany({
      where: { roundIds: { has: roundId } },
      select: { id: true, roundIds: true, endDate: true, updatedAt: true },
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

  const closureUpdates: { id: string; roundIds: string[]; updatedAt: Date }[] = [];
  const closureDeletes: string[] = [];
  for (const c of closures) {
    const roundIds = c.roundIds.filter((id) => id !== roundId);
    if (roundIds.length > 0) closureUpdates.push({ id: c.id, roundIds, updatedAt: c.updatedAt });
    else if (c.endDate >= today) closureDeletes.push(c.id);
    // else: ended, single-round closure — kept unchanged as history.
  }

  return {
    round,
    upcomingIds,
    closureUpdates,
    closureDeletes,
    preview: {
      propertyCount,
      upcomingVisitCount: upcomingIds.length,
      detachedVisitCount: totalVisits - upcomingIds.length,
      emergencyCount,
      attachedVisitCount,
      canDelete: emergencyCount === 0 && attachedVisitCount === 0,
      closuresToRemove: closureDeletes.length,
      closuresToUpdate: closureUpdates.length,
    } satisfies RoundDeletePreview,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function assertDeletable(preview: RoundDeletePreview): void {
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
}

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
      try {
        return await prisma.$transaction(async (tx) => {
          const { round, upcomingIds, closureUpdates, closureDeletes, preview } = await loadImpact(tx, roundId, today);
          assertDeletable(preview);

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
          // updatedAt kept: this is a system edit, and the web app reads updatedAt > appliedAt as "edited after apply".
          for (const c of closureUpdates) {
            await tx.businessClosure.update({ where: { id: c.id }, data: { roundIds: c.roundIds, updatedAt: c.updatedAt } });
          }
          for (const id of closureDeletes) await tx.businessClosure.delete({ where: { id } });
          await tx.round.delete({ where: { id: roundId } });

          return {
            roundName: round.name,
            deleted: true as const,
            unassignedProperties: properties.count,
            deletedVisits: deleted.count,
            detachedVisits: detached.count,
            removedClosures: closureDeletes.length,
            updatedClosures: closureUpdates.length,
          };
        });
      } catch (err) {
        // Race: an emergency or visit attachment committed by another request after our checks makes a write fail on
        // its foreign key and the transaction roll back. Answer with the same 409 the checks would have given.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          assertDeletable((await loadImpact(prisma, roundId, today)).preview);
        }
        throw err;
      }
    },
  };
}
