import { CleaningFrequency, DayOfWeek } from "../generated/tenant-client";

// Single home for round/visit date maths. Visit dates are date-only values
// stored as UTC midnight, so everything here works in UTC (getUTCDay /
// setUTCDate) and returns UTC-midnight Dates — never local time, which
// shifts across BST and on servers outside Europe/London.
//
// visitGeneration.ts and setup.service.ts still carry their own copies of
// some of these helpers; callers move over here as their features are
// reworked (A1/A2), rather than in one risky refactor.

const DAY_INDEX: Record<DayOfWeek, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const FREQ_WEEKS: Record<CleaningFrequency, number> = {
  FOUR_WEEKLY:   4,
  SIX_WEEKLY:    6,
  EIGHT_WEEKLY:  8,
  TWELVE_WEEKLY: 12,
};

export function frequencyWeeks(freq: CleaningFrequency): number {
  return FREQ_WEEKS[freq];
}

export function startOfUtcDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function addWeeks(date: Date, weeks: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d;
}

// Snap to nearest working day: Sat → Mon, Sun → Mon. Used for plans whose
// round has no defaultDay (same rule as the nightly generator).
export function snapToWeekday(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// First `day` on or after `from` (same day if `from` already is one).
export function nextOccurrenceOfDay(from: Date, day: DayOfWeek): Date {
  const d = startOfUtcDay(from);
  const daysUntil = (DAY_INDEX[day] - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntil);
  return d;
}

// nextDueDate for a newly added plan (setup step 9, POST /customers/:id/properties).
// - lastCleanedDate given: last clean + one cycle, snapped forward to the round day.
// - otherwise: the round's next defaultDay on or after today.
// - no round day either: today.
// A last-cleaned date so old that the result lands before today falls back to
// the "no lastCleanedDate" rule — the nightly generator only creates visits for
// a single nextDueDate at a time, so a past date would mint a visit in the past.
export function initialNextDueDate(input: {
  lastCleanedDate?: Date | null;
  frequency: CleaningFrequency;
  roundDefaultDay?: DayOfWeek | null;
  today: Date;
}): Date {
  const today = startOfUtcDay(input.today);
  const fromToday = input.roundDefaultDay ? nextOccurrenceOfDay(today, input.roundDefaultDay) : today;
  if (!input.lastCleanedDate) return fromToday;

  const due = nextDueAfter(input.lastCleanedDate, input.frequency, input.roundDefaultDay);
  return due < today ? fromToday : due;
}

// Visit dates for one plan in the activation window. First visit is the
// round's defaultDay on or after startDate (or startDate itself when the
// round has no day), then one every `frequency` weeks. cycleEndDate is
// EXCLUSIVE (GAP-016: an inclusive end produced one extra visit whenever the
// window was an exact multiple of the frequency). A null frequency yields
// just the first visit. Shared by activation and the step-11 preview so the
// two can't drift.
export function enumerateActivationVisits(input: {
  startDate: Date;
  cycleEndDate: Date;
  defaultDay?: DayOfWeek | null;
  frequency: CleaningFrequency | null;
}): Date[] {
  const start = startOfUtcDay(input.startDate);
  const end = startOfUtcDay(input.cycleEndDate);
  let date = input.defaultDay ? nextOccurrenceOfDay(start, input.defaultDay) : start;

  const dates: Date[] = [];
  while (date < end) {
    dates.push(date);
    if (!input.frequency) break;
    date = addWeeks(date, frequencyWeeks(input.frequency));
  }
  return dates;
}

// The next due date after a visit on `lastVisit`: one cycle later, snapped
// forward to the round day when there is one.
export function nextDueAfter(lastVisit: Date, frequency: CleaningFrequency, defaultDay?: DayOfWeek | null): Date {
  const next = addWeeks(startOfUtcDay(lastVisit), frequencyWeeks(frequency));
  return defaultDay ? nextOccurrenceOfDay(next, defaultDay) : next;
}
