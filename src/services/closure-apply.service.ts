import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError } from "../lib/app-error";
import { Prisma, VisitStatus, type DayOfWeek } from "../generated/tenant-client";
import type {
  ClosureApplyPreview,
  ClosureApplyResult,
  ClosureConflict,
  ClosureMode,
  ClosurePreviewGroup,
} from "../lib/closure-types";
import { activeClosures, resolveClosedDate, type ClosureWindow } from "../lib/closures";
import { now } from "../lib/clock";
import { tenantToday, tenantWorkingDays } from "./business-time";
import { getCachedBusinessSettings } from "./settings.service";
import { technicianIdsUnavailableOn } from "./visit-assignment";
import { cancelPendingVisitMessages } from "./visit-reschedule";
import { carryOverVisits, type MovedVisit } from "./carryover.service";
import { notifyVisitTechnicians, visitCount } from "./notify";
import { createMessageService, type BroadcastTarget } from "./message.service";
import { formatTemplateDate } from "./message-templates";

// Business closures: apply to existing visits and preview (2026-11-16). Rules: closure-rules.md section 6.
// MOVE reuses the carryover core once per (from, to) group, all in ONE transaction; the plan's nextDueDate is never
// written. SKIP marks the visits SKIPPED. Notifications run after the transaction and never fail the apply.

export const ACTIVITY_VISITS_SKIPPED_BY_CLOSURE = "VISITS_SKIPPED_BY_CLOSURE";
export const ACTIVITY_CLOSURE_MESSAGE_REASON = "BUSINESS_CLOSURE";

export const CLOSURE_MOVE_CUSTOMER_BODY =
  "Hi {{firstName}}, we're closed from {{startDate}} to {{endDate}}, so your clean at {{address}} is moving to {{newDate}}. Sorry for any inconvenience, {{businessName}}.";

export const CLOSURE_SKIP_CUSTOMER_BODY =
  "Hi {{firstName}}, we're closed from {{startDate}} to {{endDate}}, so your clean at {{address}} is skipped this time and we'll be back on our next regular visit. Sorry for any inconvenience, {{businessName}}.";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const defaultMessage = (mode: ClosureMode) => (mode === "SKIP" ? CLOSURE_SKIP_CUSTOMER_BODY : CLOSURE_MOVE_CUSTOMER_BODY);

type Customer = MovedVisit["customer"];

interface Planned {
  id: string;
  date: Date;
  roundId: string;
  roundName: string;
  technicianId: string | null;
  technicianActive: boolean | null;
  propertyId: string;
  addressLine: string;
  customer: Customer;
}

interface MoveGroup {
  from: Date;
  to: Date;
  visits: Planned[];
}

interface Plan {
  closure: { id: string; label: string; mode: ClosureMode; notifyCustomers: boolean; startDate: Date; endDate: Date };
  today: Date;
  moves: MoveGroup[];
  skips: Planned[];
}

const customerSelect = { id: true, name: true, phone: true, email: true, ghlContactId: true, messagesOptOut: true } as const;

export function createClosureApplyService(tp: TenantPrismaClient) {
  /** Selection and resolution shared by preview and apply (rules s6). Reads only. */
  const plan = async (closureId: string): Promise<Plan> => {
    const closure = await tp.businessClosure.findUnique({ where: { id: closureId } });
    if (!closure) throw new AppError(404, "Closure not found", "CLOSURE_NOT_FOUND");
    const today = await tenantToday(tp);
    if (closure.endDate < today) throw new AppError(409, "This closure has already ended", "CLOSURE_ENDED");

    const from = closure.startDate > today ? closure.startDate : today;
    const rows = await tp.visit.findMany({
      where: {
        status: VisitStatus.SCHEDULED,
        isOneOff: false,
        date: { gte: from, lte: closure.endDate },
        roundId: closure.roundIds.length > 0 ? { in: closure.roundIds } : { not: null },
      },
      select: {
        id: true,
        date: true,
        roundId: true,
        technicianId: true,
        propertyId: true,
        technician: { select: { active: true } },
        round: { select: { name: true, defaultDay: true } },
        property: { select: { addressLine: true, customer: { select: customerSelect } } },
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });

    const windows: ClosureWindow[] = activeClosures(
      (await tp.businessClosure.findMany({ where: { endDate: { gte: today } } })).map((c) => ({
        id: c.id,
        label: c.label,
        startDate: c.startDate,
        endDate: c.endDate,
        mode: c.mode as ClosureMode,
        roundIds: c.roundIds,
      })),
      today
    );
    const workingDays = await tenantWorkingDays(tp);

    const moves = new Map<string, MoveGroup>();
    const skips: Planned[] = [];
    for (const r of rows) {
      const roundId = r.roundId as string;
      const planned: Planned = {
        id: r.id,
        date: r.date,
        roundId,
        roundName: r.round!.name,
        technicianId: r.technicianId,
        technicianActive: r.technician ? r.technician.active : null,
        propertyId: r.propertyId,
        addressLine: r.property.addressLine,
        customer: r.property.customer,
      };
      // Selection guarantees the visit is covered by this closure; resolution also honours every other closure.
      const resolution = resolveClosedDate({
        visitDate: r.date,
        roundId,
        defaultDay: r.round!.defaultDay as DayOfWeek | null,
        workingDays,
        closures: windows,
      });
      if (resolution.action === "SKIP") skips.push(planned);
      else if (resolution.action === "MOVE") {
        const key = `${iso(r.date)}>${iso(resolution.date)}`;
        const group = moves.get(key) ?? { from: r.date, to: resolution.date, visits: [] };
        group.visits.push(planned);
        moves.set(key, group);
      }
    }
    const ordered = [...moves.values()].sort((a, b) => a.from.getTime() - b.from.getTime() || a.to.getTime() - b.to.getTime());
    return {
      closure: {
        id: closure.id,
        label: closure.label,
        mode: closure.mode as ClosureMode,
        notifyCustomers: closure.notifyCustomers,
        startDate: closure.startDate,
        endDate: closure.endDate,
      },
      today,
      moves: ordered,
      skips,
    };
  };

  /** Same refusals as carryover, for ALL targets before anything is written. "Today" is re-read so a midnight rollover is caught. */
  const assertTargetsOpen = async (moves: MoveGroup[]) => {
    if (moves.length === 0) return;
    const today = await tenantToday(tp);
    const closedDay = (await getCachedBusinessSettings(tp))?.lastClosedDate ?? null;
    for (const m of moves) {
      if (m.to < today) throw new AppError(400, "The target day is in the past", "CARRYOVER_TARGET_IN_PAST");
      if (closedDay === iso(m.to)) throw new AppError(409, "The target day has already been closed", "CARRYOVER_TARGET_CLOSED");
    }
  };

  const previewConflicts = async (moves: MoveGroup[]): Promise<ClosureConflict[]> => {
    const conflicts: ClosureConflict[] = [];
    for (const m of moves) {
      const unavailable = await technicianIdsUnavailableOn(tp, m.to);
      for (const v of m.visits) {
        if (!v.technicianId) continue;
        if (v.technicianActive === false) conflicts.push({ visitId: v.id, technicianId: v.technicianId, reason: "TECHNICIAN_INACTIVE" });
        else if (unavailable.has(v.technicianId)) conflicts.push({ visitId: v.id, technicianId: v.technicianId, reason: "TECHNICIAN_UNAVAILABLE" });
      }
    }
    return conflicts;
  };

  const notifyTechnicians = async (
    kind: "moved" | "skipped",
    visits: Planned[],
    p: Plan["closure"],
    dateFor: (v: Planned) => Date
  ): Promise<void> => {
    try {
      await notifyVisitTechnicians(
        tp,
        visits.map((v) => ({ id: v.id, technicianId: v.technicianId, roundId: v.roundId, propertyId: v.propertyId, date: dateFor(v) })),
        ({ count }) => ({
          type: "SCHEDULE",
          title: kind === "moved" ? `${visitCount(count)} moved for ${p.label}` : `${visitCount(count)} skipped for ${p.label}`,
          body: `We're closed from ${iso(p.startDate)} to ${iso(p.endDate)}.`,
        })
      );
    } catch (err) {
      console.error("[closures] notifying technicians failed:", err);
    }
  };

  const notifyCustomers = async (
    p: Plan,
    businessName: string
  ): Promise<{ notified: number; error?: string }> => {
    try {
      const seen = new Set<string>();
      const build = (visits: { v: Planned; newDate?: Date }[]): BroadcastTarget[] => {
        const out: BroadcastTarget[] = [];
        for (const { v, newDate } of visits) {
          if (seen.has(v.customer.id)) continue;
          seen.add(v.customer.id);
          out.push({
            customer: v.customer,
            vars: {
              customerName: v.customer.name,
              firstName: v.customer.name.split(" ")[0],
              address: v.addressLine,
              date: formatTemplateDate(v.date),
              newDate: newDate ? formatTemplateDate(newDate) : "",
              startDate: formatTemplateDate(p.closure.startDate),
              endDate: formatTemplateDate(p.closure.endDate),
              businessName,
            },
          });
        }
        return out;
      };
      const moved = build(p.moves.flatMap((m) => m.visits.map((v) => ({ v, newDate: m.to }))));
      const skipped = build(p.skips.map((v) => ({ v })));
      const messages = createMessageService(tp);
      let notified = 0;
      for (const [targets, body] of [
        [moved, CLOSURE_MOVE_CUSTOMER_BODY],
        [skipped, CLOSURE_SKIP_CUSTOMER_BODY],
      ] as const) {
        if (targets.length === 0) continue;
        const sent = await messages.broadcast([...targets], {
          body,
          reason: ACTIVITY_CLOSURE_MESSAGE_REASON,
          extraPayload: { closureId: p.closure.id },
        });
        notified += sent.sent + sent.scheduled;
      }
      return { notified };
    } catch (err) {
      console.error("[closures] notifying customers failed:", err);
      return { notified: 0, error: (err as Error).message };
    }
  };

  return {
    /** The same selection and computation as apply, with no writes. Groups per round, never one row per visit. */
    async preview(closureId: string): Promise<ClosureApplyPreview> {
      const p = await plan(closureId);
      await assertTargetsOpen(p.moves);
      const conflicts = await previewConflicts(p.moves);

      const rounds = new Map<string, { roundId: string; roundName: string; visitCount: number; groups: Map<string, ClosurePreviewGroup> }>();
      const add = (v: Planned, from: Date, to: Date | null) => {
        const r = rounds.get(v.roundId) ?? { roundId: v.roundId, roundName: v.roundName, visitCount: 0, groups: new Map() };
        r.visitCount++;
        const key = `${iso(from)}>${to ? iso(to) : ""}`;
        const g = r.groups.get(key) ?? { from: iso(from), to: to ? iso(to) : null, count: 0 };
        g.count++;
        r.groups.set(key, g);
        rounds.set(v.roundId, r);
      };
      for (const m of p.moves) for (const v of m.visits) add(v, m.from, m.to);
      for (const v of p.skips) add(v, v.date, null);

      const customers = new Set<string>();
      for (const m of p.moves) for (const v of m.visits) customers.add(v.customer.id);
      for (const v of p.skips) customers.add(v.customer.id);

      const list = [...rounds.values()].sort((a, b) => a.roundName.localeCompare(b.roundName) || a.roundId.localeCompare(b.roundId));
      return {
        closureId: p.closure.id,
        mode: p.closure.mode,
        totals: {
          visits: list.reduce((n, r) => n + r.visitCount, 0),
          rounds: list.length,
          customers: customers.size,
          technicianConflicts: conflicts.length,
        },
        rounds: list.map((r) => ({
          roundId: r.roundId,
          roundName: r.roundName,
          visitCount: r.visitCount,
          groups: [...r.groups.values()].sort((a, b) => a.from.localeCompare(b.from)),
        })),
        conflicts,
        customerMessage: defaultMessage(p.closure.mode),
      };
    },

    async apply(
      closureId: string,
      input: { notifyCustomers?: boolean; actor?: { id?: string | null; role?: string | null } } = {}
    ): Promise<ClosureApplyResult> {
      const p = await plan(closureId);
      await assertTargetsOpen(p.moves);
      const appliedAt = now();

      const conflicts: ClosureConflict[] = [];
      let moved: MovedVisit[] = [];
      let skippedCount = 0;
      await tp.$transaction(async (tx) => {
        // Serialize applies of the same closure: without the lock two concurrent applies both read the visits before either commits
        // (read committed) and each re-moves them, doubling carryoverCount. The second apply waits here, then its own re-read inside
        // carryOverVisits sees the visits already on their new date, skips them (NOT_ON_DATE) and reports moved 0.
        await tx.$queryRaw`SELECT "id" FROM "BusinessClosure" WHERE "id" = ${p.closure.id} FOR UPDATE`;
        for (const m of p.moves) {
          const core = await carryOverVisits(tx, {
            fromDate: m.from,
            targetDate: m.to,
            visitIds: m.visits.map((v) => v.id),
            actor: input.actor,
            via: "closure",
          });
          moved = moved.concat(core.moved);
          conflicts.push(...core.conflicts);
        }
        if (p.skips.length > 0) {
          const ids = p.skips.map((v) => v.id);
          const res = await tx.visit.updateMany({
            where: { id: { in: ids }, status: VisitStatus.SCHEDULED },
            data: { status: VisitStatus.SKIPPED, skipReason: p.closure.label },
          });
          skippedCount = res.count;
          const cancelledReminders = await cancelPendingVisitMessages(tx, ids, `Closure: ${p.closure.label}`);
          await tx.activityLog.create({
            data: {
              type: ACTIVITY_VISITS_SKIPPED_BY_CLOSURE,
              message: `${visitCount(res.count)} skipped for closure "${p.closure.label}"`,
              actorId: input.actor?.id ?? null,
              actorRole: input.actor?.role ?? null,
              entityId: p.closure.id,
              details: { closureId: p.closure.id, label: p.closure.label, visitIds: ids, cancelledReminders } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        // updatedAt is written explicitly (the same instant as appliedAt): Prisma's automatic @updatedAt would land a few milliseconds
        // later, and the web app reads "updatedAt > appliedAt" as "edited after it was applied", so every apply would look edited.
        await tx.businessClosure.update({ where: { id: p.closure.id }, data: { appliedAt, updatedAt: appliedAt } });
      });

      const toDate = new Map(p.moves.flatMap((m) => m.visits.map((v) => [v.id, m.to] as const)));
      const movedIds = new Set(moved.map((m) => m.id));
      const movedPlanned = p.moves.flatMap((m) => m.visits).filter((v) => movedIds.has(v.id));
      const technicians = new Set<string>();
      for (const v of [...movedPlanned, ...p.skips]) if (v.technicianId) technicians.add(v.technicianId);
      if (movedPlanned.length > 0) await notifyTechnicians("moved", movedPlanned, p.closure, (v) => toDate.get(v.id)!);
      if (p.skips.length > 0) await notifyTechnicians("skipped", p.skips, p.closure, (v) => v.date);

      const result: ClosureApplyResult = {
        closureId: p.closure.id,
        mode: p.closure.mode,
        moved: moved.length,
        skipped: skippedCount,
        conflicts,
        notifiedTechnicians: technicians.size,
        notifiedCustomers: 0,
        appliedAt: appliedAt.toISOString(),
      };

      const tell = input.notifyCustomers ?? p.closure.notifyCustomers;
      if (tell && (movedPlanned.length > 0 || p.skips.length > 0)) {
        const businessName = (await getCachedBusinessSettings(tp))?.businessName ?? "";
        const sent = await notifyCustomers({ ...p, moves: p.moves.map((m) => ({ ...m, visits: m.visits.filter((v) => movedIds.has(v.id)) })) }, businessName);
        result.notifiedCustomers = sent.notified;
        if (sent.error) result.customerNotificationError = sent.error;
      }
      return result;
    },
  };
}

export type ClosureApplyService = ReturnType<typeof createClosureApplyService>;

