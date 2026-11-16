import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { AppError, ValidationError, type FieldError } from "../lib/app-error";
import { CLOSURE_LABEL_MAX, CLOSURE_MAX_DAYS, type Closure, type ClosureListResult, type IsoDate } from "../lib/closure-types";
import { tenantToday } from "./business-time";

// Business closures CRUD (2026-11-16). Rules: docs/handoff/backend/2026-11-16-closure-rules.md section 2.
// Dates are stored as UTC-midnight DateTimes and exposed as YYYY-MM-DD. Error codes: VALIDATION_FAILED,
// INVALID_CLOSURE_RANGE, UNKNOWN_ROUND, CLOSURE_NOT_FOUND (see ClosureErrorCode).

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const MODES = ["MOVE", "SKIP"] as const;
const WRITE_FIELDS = ["label", "startDate", "endDate", "mode", "notifyCustomers", "roundIds"] as const;

const NOT_FOUND = () => new AppError(404, "Closure not found", "CLOSURE_NOT_FOUND");
const rangeError = (message: string) => new AppError(400, message, "INVALID_CLOSURE_RANGE");

function invalid(path: string, message: string): ValidationError {
  const field: FieldError = { path, code: "VALIDATION_FAILED", message };
  return new ValidationError(message, [field]);
}

/** YYYY-MM-DD -> UTC-midnight Date; null when the string is not a real calendar day. */
function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function requireDay(value: unknown, field: string): Date {
  const d = parseDay(value);
  if (!d) throw invalid(field, `"${field}" must be a valid date in YYYY-MM-DD format.`);
  return d;
}

const iso = (d: Date): IsoDate => d.toISOString().slice(0, 10);

function parseLabel(value: unknown): string {
  if (typeof value !== "string") throw invalid("label", `"label" must be a string.`);
  const label = value.trim();
  if (label.length < 1 || label.length > CLOSURE_LABEL_MAX) {
    throw invalid("label", `"label" must be 1 to ${CLOSURE_LABEL_MAX} characters.`);
  }
  if (CONTROL_CHARS.test(label)) throw invalid("label", `"label" must be plain text (no control characters).`);
  return label;
}

function parseMode(value: unknown): "MOVE" | "SKIP" {
  if (!(MODES as readonly unknown[]).includes(value)) throw invalid("mode", `"mode" must be one of: ${MODES.join(", ")}.`);
  return value as "MOVE" | "SKIP";
}

function parseNotify(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid("notifyCustomers", `"notifyCustomers" must be a boolean.`);
  return value;
}

/** Array of non-empty strings; duplicates are collapsed (order kept). */
function parseRoundIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && x !== "")) {
    throw invalid("roundIds", `"roundIds" must be an array of round ids.`);
  }
  return [...new Set(value as string[])];
}

interface ParsedFields {
  label?: string;
  startDate?: Date;
  endDate?: Date;
  mode?: "MOVE" | "SKIP";
  notifyCustomers?: boolean;
  roundIds?: string[];
}

/** Shape validation of a create or update body: unknown fields are rejected; every supplied field must be valid. */
function parseBody(body: unknown, requireAll: boolean): ParsedFields {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body", "Request body must be a JSON object.");
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !(WRITE_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown field(s): ${unknown.join(", ")}`,
      unknown.map((path) => ({ path, code: "VALIDATION_FAILED", message: `"${path}" is not a known field.` }))
    );
  }
  if (requireAll) {
    for (const f of ["label", "startDate", "endDate", "mode"] as const) {
      if (raw[f] === undefined) throw invalid(f, `"${f}" is required.`);
    }
  }
  const out: ParsedFields = {};
  if (raw.label !== undefined) out.label = parseLabel(raw.label);
  if (raw.startDate !== undefined) out.startDate = requireDay(raw.startDate, "startDate");
  if (raw.endDate !== undefined) out.endDate = requireDay(raw.endDate, "endDate");
  if (raw.mode !== undefined) out.mode = parseMode(raw.mode);
  if (raw.notifyCustomers !== undefined) out.notifyCustomers = parseNotify(raw.notifyCustomers);
  if (raw.roundIds !== undefined) out.roundIds = parseRoundIds(raw.roundIds);
  return out;
}

function assertRange(start: Date, end: Date): void {
  if (end < start) throw rangeError("endDate must be on or after startDate.");
  if ((end.getTime() - start.getTime()) / DAY_MS + 1 > CLOSURE_MAX_DAYS) {
    throw rangeError(`A closure can be at most ${CLOSURE_MAX_DAYS} days long.`);
  }
}

type Row = {
  id: string;
  label: string;
  startDate: Date;
  endDate: Date;
  mode: string;
  notifyCustomers: boolean;
  roundIds: string[];
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toClosureDto(r: Row): Closure {
  return {
    id: r.id,
    label: r.label,
    startDate: iso(r.startDate),
    endDate: iso(r.endDate),
    mode: r.mode as Closure["mode"],
    notifyCustomers: r.notifyCustomers,
    roundIds: r.roundIds,
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function queryDay(value: unknown, field: string): Date | undefined {
  return value === undefined ? undefined : requireDay(value, field);
}

export function createClosureService(tp: TenantPrismaClient) {
  const assertRoundsExist = async (ids: string[]) => {
    if (ids.length === 0) return;
    const found = await tp.round.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const known = new Set(found.map((r) => r.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new AppError(400, `Unknown round id(s): ${missing.join(", ")}`, "UNKNOWN_ROUND");
  };

  const assertNotPast = async (end: Date) => {
    if (end < (await tenantToday(tp))) throw rangeError("A closure cannot end in the past.");
  };

  return {
    /** Default: closures whose endDate >= tenant-local today. With from/to: closures overlapping that window. */
    async list(query: { from?: unknown; to?: unknown } = {}): Promise<ClosureListResult> {
      const from = queryDay(query.from, "from");
      const to = queryDay(query.to, "to");
      if (from && to && to < from) throw invalid("to", `"to" must be on or after "from".`);
      const where =
        from || to
          ? { ...(from ? { endDate: { gte: from } } : {}), ...(to ? { startDate: { lte: to } } : {}) }
          : { endDate: { gte: await tenantToday(tp) } };
      const rows = await tp.businessClosure.findMany({ where, orderBy: [{ startDate: "asc" }, { createdAt: "asc" }] });
      return { closures: rows.map(toClosureDto) };
    },

    async create(body: unknown, createdById: string | null): Promise<Closure> {
      const f = parseBody(body, true) as Required<Pick<ParsedFields, "label" | "startDate" | "endDate" | "mode">> & ParsedFields;
      assertRange(f.startDate, f.endDate);
      await assertNotPast(f.endDate);
      const roundIds = f.roundIds ?? [];
      await assertRoundsExist(roundIds);
      const row = await tp.businessClosure.create({
        data: {
          label: f.label,
          startDate: f.startDate,
          endDate: f.endDate,
          mode: f.mode,
          notifyCustomers: f.notifyCustomers ?? false,
          roundIds,
          createdById,
        },
      });
      return toClosureDto(row);
    },

    /** Partial update. The "ends in the past" check runs only when startDate or endDate was supplied. */
    async update(id: string, body: unknown): Promise<Closure> {
      const f = parseBody(body, false);
      const existing = await tp.businessClosure.findUnique({ where: { id } });
      if (!existing) throw NOT_FOUND();
      const start = f.startDate ?? existing.startDate;
      const end = f.endDate ?? existing.endDate;
      assertRange(start, end);
      if (f.startDate || f.endDate) await assertNotPast(end);
      if (f.roundIds) await assertRoundsExist(f.roundIds);
      const row = await tp.businessClosure.update({ where: { id }, data: f });
      return toClosureDto(row);
    },

    async remove(id: string): Promise<void> {
      const existing = await tp.businessClosure.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw NOT_FOUND();
      await tp.businessClosure.delete({ where: { id } });
    },
  };
}

export type ClosureService = ReturnType<typeof createClosureService>;
