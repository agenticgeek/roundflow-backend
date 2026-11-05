import { prisma } from "../lib/prisma";
import { getTenantPrismaForSchema, type TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { LifecycleStatus, RoundStatus, VisitStatus } from "../generated/tenant-client";
import { initialNextDueDate, nextDueAfter, startOfUtcDay } from "../lib/schedule";
import { restampFutureVisits } from "../services/visit-assignment";

// One-off, idempotent data backfills for the Phase 1 audit remediation
// (X-1, X-2). Logic lives here so it is unit-tested; scripts/backfill-*.ts
// are thin CLI wrappers. Each runs per tenant and supports a dry run.

export type TenantResult<T> = { schemaName: string; result?: T; error?: string };

// Thrown inside a dry-run transaction to roll it back after counting.
class DryRunRollback extends Error {}

// Run `fn` for every tenant schema. One failing tenant is recorded and
// logged but doesn't stop the rest (same policy as migrateAllTenantSchemas).
export async function forEachTenant<T>(
  fn: (tp: TenantPrismaClient, schemaName: string) => Promise<T>
): Promise<TenantResult<T>[]> {
  const tenants = await prisma.tenant.findMany({ select: { schemaName: true } });
  const results: TenantResult<T>[] = [];
  for (const { schemaName } of tenants) {
    try {
      results.push({ schemaName, result: await fn(getTenantPrismaForSchema(schemaName), schemaName) });
    } catch (err) {
      console.error(`[backfill] ${schemaName}: FAILED —`, err);
      results.push({ schemaName, error: String(err) });
    }
  }
  return results;
}

// ── X-1: stamp technicians on future visits ─────────────────────────────────

export type VisitTechnicianBackfill = { rounds: number; visitsUpdated: number };

// Restamps every ACTIVE round's future SCHEDULED visits. A dry run performs
// the real updates inside a transaction and rolls it back, so the reported
// count is exact without persisting anything.
export async function backfillVisitTechniciansForTenant(
  tp: TenantPrismaClient,
  opts: { today: Date; dryRun: boolean }
): Promise<VisitTechnicianBackfill> {
  const run = async (db: Parameters<typeof restampFutureVisits>[0]): Promise<VisitTechnicianBackfill> => {
    const rounds = await db.round.findMany({ where: { status: RoundStatus.ACTIVE }, select: { id: true } });
    let visitsUpdated = 0;
    for (const round of rounds) {
      visitsUpdated += await restampFutureVisits(db, round.id, opts.today);
    }
    return { rounds: rounds.length, visitsUpdated };
  };

  if (!opts.dryRun) return run(tp);

  let counted: VisitTechnicianBackfill = { rounds: 0, visitsUpdated: 0 };
  try {
    await tp.$transaction(async (tx) => {
      counted = await run(tx);
      throw new DryRunRollback("dry run");
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return counted;
}

// ── X-2: nextDueDate on ACTIVE plans ────────────────────────────────────────

export type NextDueDateBackfill = { plans: number; updated: number; skipped: number };

// ACTIVE plans with a null nextDueDate get:
// - one cycle after their latest visit (snapped to the round day), or
// - initialNextDueDate (from lastCompleted, else the next round day) when
//   they have no visits or that date is already past.
// Plans with no frequency on either the plan or its round are skipped.
// Idempotent: only null nextDueDate rows are selected.
export async function backfillNextDueDateForTenant(
  tp: TenantPrismaClient,
  opts: { today: Date; dryRun: boolean }
): Promise<NextDueDateBackfill> {
  const today = startOfUtcDay(opts.today);
  const plans = await tp.servicePlan.findMany({
    where: { status: LifecycleStatus.ACTIVE, nextDueDate: null },
    select: {
      id: true,
      cleaningFrequency: true,
      lastCompleted: true,
      property: { select: { round: { select: { defaultDay: true, frequency: true } } } },
      visits: {
        where: { status: { notIn: [VisitStatus.CANCELLED, VisitStatus.SKIPPED] } },
        orderBy: { date: "desc" },
        take: 1,
        select: { date: true },
      },
    },
  });

  // Group plans by target date so each distinct date is one updateMany.
  const byDate = new Map<string, string[]>();
  let skipped = 0;
  for (const plan of plans) {
    const round = plan.property.round;
    const frequency = plan.cleaningFrequency ?? round?.frequency ?? null;
    if (!frequency) {
      skipped++;
      continue;
    }
    const roundDefaultDay = round?.defaultDay ?? null;
    const latest = plan.visits[0]?.date;
    const afterLatest = latest ? nextDueAfter(latest, frequency, roundDefaultDay) : null;
    const due =
      afterLatest && afterLatest >= today
        ? afterLatest
        : initialNextDueDate({ lastCleanedDate: latest ? null : plan.lastCompleted, frequency, roundDefaultDay, today });

    const key = due.toISOString();
    const ids = byDate.get(key) ?? [];
    ids.push(plan.id);
    byDate.set(key, ids);
  }

  let updated = 0;
  for (const [iso, ids] of byDate) {
    if (!opts.dryRun) {
      await tp.servicePlan.updateMany({ where: { id: { in: ids }, nextDueDate: null }, data: { nextDueDate: new Date(iso) } });
    }
    updated += ids.length;
  }
  return { plans: plans.length, updated, skipped };
}

// ── GAP-002: completedSteps for tenants mid-setup ──────────────────────────

export type CompletedStepsBackfill = {
  skipped: boolean; // no settings row, or setup already completed
  before: number[];
  after: number[];
  added: number[];
};

// Setup steps used to be "complete" whenever matching rows existed; they are
// now complete only once saved (BusinessSettings.completedSteps). A tenant
// still in the wizard would otherwise see earlier progress vanish, so this
// unions the steps the OLD row-count rules considered complete into
// completedSteps. Tenants that already finished setup are left alone.
// Idempotent: re-running adds nothing new.
export async function backfillCompletedStepsForTenant(
  tp: TenantPrismaClient,
  opts: { dryRun: boolean }
): Promise<CompletedStepsBackfill> {
  const settings = await tp.businessSettings.findFirst({
    select: {
      id: true,
      setupCompleted: true,
      completedSteps: true,
      businessName: true,
      paymentRule: true,
      defaultCycleLength: true,
    },
  });
  if (!settings || settings.setupCompleted) {
    const current = settings?.completedSteps ?? [];
    return { skipped: true, before: current, after: current, added: [] };
  }

  const [services, templates, technicians, serviceAreas, activeRounds, roundedProperties, scheduledVisits, rounds] =
    await Promise.all([
      tp.service.count(),
      tp.messageTemplate.count(),
      tp.technician.count(),
      tp.serviceArea.count(),
      tp.round.count({ where: { status: RoundStatus.ACTIVE } }),
      tp.property.count({ where: { roundId: { not: null } } }),
      tp.visit.count({ where: { status: VisitStatus.SCHEDULED } }),
      tp.round.findMany({
        where: { status: RoundStatus.ACTIVE },
        select: { roundTechnicians: { select: { technicianId: true } } },
      }),
    ]);

  const oldRules: Array<[number, boolean]> = [
    [1, settings.businessName != null],
    [2, settings.paymentRule != null],
    [3, services > 0],
    [4, settings.defaultCycleLength != null],
    [5, templates > 0],
    [6, technicians > 0],
    [7, serviceAreas > 0],
    [8, activeRounds > 0],
    [9, roundedProperties > 0],
    [10, rounds.length > 0 && rounds.every((r) => r.roundTechnicians.length > 0)],
    [11, scheduledVisits > 0],
  ];

  const before = settings.completedSteps;
  const added = oldRules.filter(([n, complete]) => complete && !before.includes(n)).map(([n]) => n);
  const after = [...before, ...added].sort((a, b) => a - b);
  if (added.length > 0 && !opts.dryRun) {
    await tp.businessSettings.update({ where: { id: settings.id }, data: { completedSteps: after } });
  }
  return { skipped: false, before, after, added };
}

// ── CLI entry points (scripts/backfill-*.ts) ────────────────────────────────

export function runVisitTechnicianBackfill(opts: { dryRun: boolean; today?: Date }) {
  const today = startOfUtcDay(opts.today ?? new Date());
  return forEachTenant((tp) => backfillVisitTechniciansForTenant(tp, { today, dryRun: opts.dryRun }));
}

export function runNextDueDateBackfill(opts: { dryRun: boolean; today?: Date }) {
  const today = startOfUtcDay(opts.today ?? new Date());
  return forEachTenant((tp) => backfillNextDueDateForTenant(tp, { today, dryRun: opts.dryRun }));
}

export function runCompletedStepsBackfill(opts: { dryRun: boolean }) {
  return forEachTenant((tp) => backfillCompletedStepsForTenant(tp, { dryRun: opts.dryRun }));
}

// Shared CLI driver: parses --dry-run, runs the backfill, prints one line per
// tenant, and returns the process exit code (1 if any tenant failed).
export async function runBackfillCli<T>(
  name: string,
  argv: string[],
  run: (opts: { dryRun: boolean }) => Promise<TenantResult<T>[]>
): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  console.log(`[${name}] starting${dryRun ? " (dry run — no changes will be saved)" : ""}`);
  const results = await run({ dryRun });
  for (const r of results) {
    console.log(`[${name}] ${r.schemaName}: ${r.error ? `FAILED — ${r.error}` : JSON.stringify(r.result)}`);
  }
  const failed = results.filter((r) => r.error).length;
  console.log(`[${name}] done: ${results.length} tenant(s), ${failed} failed`);
  return failed > 0 ? 1 : 0;
}
