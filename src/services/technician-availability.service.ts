import { VisitStatus } from "../generated/tenant-client";
import type { TechnicianAvailability } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { startOfUtcDay } from "../lib/schedule";
import { restampFutureVisits } from "./visit-assignment";
import { createNotificationService } from "../mobile/services/notification.service";

// Technician leave and cover (GAP-030). Availability windows are inclusive
// date-only ranges [from, to]; visit-assignment.ts skips a technician for
// visit dates inside one. Adding or removing a window restamps the
// technician's rounds so future visits follow straight away (visits a
// manager reassigned by hand keep their technician).

// TechnicianAvailability.to is required; an open-ended replacement stores
// this far-future date instead.
export const OPEN_ENDED_TO = new Date(Date.UTC(2099, 11, 31));

const DAY_MS = 86_400_000;

export interface AvailabilityInput {
  from: Date;
  to: Date;
  reason?: string | null;
}

export interface ReplaceInput {
  replacementTechnicianId: string;
  from: Date;
  to?: Date | null; // omitted = open-ended
  notify: boolean;
}

export function createTechnicianAvailabilityService(tp: TenantPrismaClient) {
  const findTechnician = async (id: string, label = "Technician") => {
    const tech = await tp.technician.findUnique({
      where: { id },
      select: { id: true, name: true, active: true, profileId: true },
    });
    if (!tech) throw new AppError(404, `${label} not found`);
    return tech;
  };

  // Restamp every round the technician is on; returns visits changed.
  const restampTechnicianRounds = async (technicianId: string, now: Date): Promise<number> => {
    const rounds = await tp.roundTechnician.findMany({ where: { technicianId }, select: { roundId: true } });
    let updated = 0;
    for (const { roundId } of rounds) updated += await restampFutureVisits(tp, roundId, now);
    return updated;
  };

  // Push + inbox notification; never fails the request.
  const notify = async (profileId: string | null, title: string, body: string) => {
    if (!profileId) return;
    try {
      await createNotificationService(tp).create(profileId, "SCHEDULE", title, body);
    } catch (err) {
      console.error("[technicians] replace notification failed:", err);
    }
  };

  return {
    async list(technicianId: string): Promise<TechnicianAvailability[]> {
      await findTechnician(technicianId);
      return tp.technicianAvailability.findMany({ where: { technicianId }, orderBy: { from: "desc" } });
    },

    async create(
      technicianId: string,
      input: AvailabilityInput,
      now: Date
    ): Promise<TechnicianAvailability & { visitsRestamped: number }> {
      await findTechnician(technicianId);
      const row = await tp.technicianAvailability.create({
        data: {
          technicianId,
          from: startOfUtcDay(input.from),
          to: startOfUtcDay(input.to),
          reason: input.reason ?? null,
        },
      });
      const visitsRestamped = await restampTechnicianRounds(technicianId, now);
      return { ...row, visitsRestamped };
    },

    async remove(technicianId: string, availabilityId: string, now: Date): Promise<void> {
      const row = await tp.technicianAvailability.findUnique({ where: { id: availabilityId } });
      if (!row || row.technicianId !== technicianId) throw new AppError(404, "Availability not found");
      await tp.technicianAvailability.delete({ where: { id: availabilityId } });
      await restampTechnicianRounds(technicianId, now);
    },

    // Hand the technician's SCHEDULED visits in [from, to] to the replacement
    // (marked technicianOverride so restamping won't undo it) and record the
    // window as unavailability, in one transaction.
    async replace(technicianId: string, input: ReplaceInput): Promise<{ visitsReassigned: number }> {
      if (input.replacementTechnicianId === technicianId) {
        throw new AppError(400, "replacementTechnicianId must be a different technician");
      }
      const tech = await findTechnician(technicianId);
      const replacement = await findTechnician(input.replacementTechnicianId, "Replacement technician");
      if (!replacement.active) throw new AppError(400, "Replacement technician is inactive");

      const from = startOfUtcDay(input.from);
      const to = input.to ? startOfUtcDay(input.to) : null;

      const visitsReassigned = await tp.$transaction(async (tx) => {
        const res = await tx.visit.updateMany({
          where: {
            technicianId,
            status: VisitStatus.SCHEDULED,
            date: to ? { gte: from, lt: new Date(to.getTime() + DAY_MS) } : { gte: from },
          },
          data: { technicianId: replacement.id, technicianOverride: true },
        });
        await tx.technicianAvailability.create({
          data: {
            technicianId,
            from,
            to: to ?? OPEN_ENDED_TO,
            reason: `Replaced by ${replacement.name ?? "another technician"}`,
          },
        });
        return res.count;
      });

      if (input.notify) {
        const window = `${from.toISOString().slice(0, 10)}${to ? ` to ${to.toISOString().slice(0, 10)}` : " onwards"}`;
        await notify(
          replacement.profileId,
          "New jobs assigned",
          `${visitsReassigned} visit(s) from ${tech.name ?? "a colleague"}, ${window}.`
        );
        await notify(tech.profileId, "Jobs reassigned", `Your visits ${window} were reassigned to ${replacement.name ?? "another technician"}.`);
      }
      return { visitsReassigned };
    },
  };
}
