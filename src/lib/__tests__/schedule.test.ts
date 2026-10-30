import { describe, it, expect } from "vitest";
import {
  addWeeks,
  enumerateActivationVisits,
  frequencyWeeks,
  initialNextDueDate,
  nextDueAfter,
  nextOccurrenceOfDay,
  snapToWeekday,
  startOfUtcDay,
} from "../schedule";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

// 2026-10-30 is a Friday.

describe("frequencyWeeks", () => {
  it("maps every frequency", () => {
    expect(frequencyWeeks("FOUR_WEEKLY")).toBe(4);
    expect(frequencyWeeks("SIX_WEEKLY")).toBe(6);
    expect(frequencyWeeks("EIGHT_WEEKLY")).toBe(8);
    expect(frequencyWeeks("TWELVE_WEEKLY")).toBe(12);
  });
});

describe("startOfUtcDay / addWeeks", () => {
  it("strips the time in UTC without mutating the input", () => {
    const input = new Date("2026-10-30T23:30:00.000Z");
    expect(startOfUtcDay(input).toISOString()).toBe("2026-10-30T00:00:00.000Z");
    expect(input.toISOString()).toBe("2026-10-30T23:30:00.000Z");
  });

  it("adds whole weeks across the BST change", () => {
    expect(iso(addWeeks(d("2026-10-20"), 2))).toBe("2026-11-03");
  });
});

describe("snapToWeekday", () => {
  it("moves Saturday and Sunday to Monday and leaves weekdays alone", () => {
    expect(iso(snapToWeekday(d("2026-10-31")))).toBe("2026-11-02");
    expect(iso(snapToWeekday(d("2026-11-01")))).toBe("2026-11-02");
    expect(iso(snapToWeekday(d("2026-10-30")))).toBe("2026-10-30");
  });
});

describe("nextOccurrenceOfDay", () => {
  it("returns the same day when it already matches", () => {
    expect(iso(nextOccurrenceOfDay(d("2026-10-30"), "FRI"))).toBe("2026-10-30");
  });

  it("rolls forward to the next matching day, normalised to UTC midnight", () => {
    expect(nextOccurrenceOfDay(new Date("2026-10-30T15:00:00Z"), "MON").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(iso(nextOccurrenceOfDay(d("2026-10-30"), "THU"))).toBe("2026-11-05");
    expect(iso(nextOccurrenceOfDay(d("2026-10-30"), "SUN"))).toBe("2026-11-01");
  });
});

describe("nextDueAfter", () => {
  it("adds one cycle and snaps forward to the round day", () => {
    // 2026-10-30 + 4w = 2026-11-27 (Fri) → next Mon 2026-11-30
    expect(iso(nextDueAfter(d("2026-10-30"), "FOUR_WEEKLY", "MON"))).toBe("2026-11-30");
  });

  it("adds one cycle unchanged with no round day", () => {
    expect(iso(nextDueAfter(d("2026-10-30"), "SIX_WEEKLY"))).toBe("2026-12-11");
    expect(iso(nextDueAfter(d("2026-10-30"), "TWELVE_WEEKLY", null))).toBe("2027-01-22");
  });
});

describe("initialNextDueDate", () => {
  const today = new Date("2026-10-30T10:00:00Z");

  it("uses last cleaned + frequency snapped to the round day", () => {
    expect(iso(initialNextDueDate({ lastCleanedDate: d("2026-10-20"), frequency: "FOUR_WEEKLY", roundDefaultDay: "WED", today })))
      .toBe("2026-11-18");
  });

  it("handles a last-cleaned date in the future", () => {
    expect(iso(initialNextDueDate({ lastCleanedDate: d("2026-11-10"), frequency: "EIGHT_WEEKLY", today })))
      .toBe("2027-01-05");
  });

  it("falls back to the next round day when last cleaned + frequency is already past", () => {
    expect(iso(initialNextDueDate({ lastCleanedDate: d("2026-01-01"), frequency: "FOUR_WEEKLY", roundDefaultDay: "TUE", today })))
      .toBe("2026-11-03");
  });

  it("falls back to today when long overdue and the round has no day", () => {
    expect(initialNextDueDate({ lastCleanedDate: d("2026-01-01"), frequency: "FOUR_WEEKLY", today }).toISOString())
      .toBe("2026-10-30T00:00:00.000Z");
  });

  it("uses the next round day on or after today with no last-cleaned date", () => {
    expect(iso(initialNextDueDate({ frequency: "FOUR_WEEKLY", roundDefaultDay: "MON", today }))).toBe("2026-11-02");
    expect(iso(initialNextDueDate({ lastCleanedDate: null, frequency: "FOUR_WEEKLY", roundDefaultDay: "FRI", today }))).toBe("2026-10-30");
  });

  it("uses today with neither", () => {
    expect(iso(initialNextDueDate({ frequency: "SIX_WEEKLY", roundDefaultDay: null, today }))).toBe("2026-10-30");
  });
});

describe("enumerateActivationVisits", () => {
  it("starts on the round day and steps by frequency with an exclusive end (GAP-016)", () => {
    // Mon 2026-11-02, +4w each; 12-week window from Fri 2026-10-30 ends Fri 2027-01-22.
    const dates = enumerateActivationVisits({
      startDate: d("2026-10-30"), cycleEndDate: d("2027-01-22"), defaultDay: "MON", frequency: "FOUR_WEEKLY",
    });
    expect(dates.map(iso)).toEqual(["2026-11-02", "2026-11-30", "2026-12-28"]);
  });

  it("excludes a visit falling exactly on the end date", () => {
    const dates = enumerateActivationVisits({
      startDate: d("2026-11-02"), cycleEndDate: d("2026-11-30"), defaultDay: "MON", frequency: "FOUR_WEEKLY",
    });
    expect(dates.map(iso)).toEqual(["2026-11-02"]);
  });

  it("starts on startDate when the round has no day", () => {
    const dates = enumerateActivationVisits({
      startDate: new Date("2026-10-30T12:00:00Z"), cycleEndDate: d("2026-12-31"), defaultDay: null, frequency: "SIX_WEEKLY",
    });
    expect(dates.map(iso)).toEqual(["2026-10-30", "2026-12-11"]);
  });

  it("yields only the first visit with no frequency", () => {
    const dates = enumerateActivationVisits({
      startDate: d("2026-10-30"), cycleEndDate: d("2027-06-01"), frequency: null,
    });
    expect(dates.map(iso)).toEqual(["2026-10-30"]);
  });

  it("yields nothing when the first visit is on or after the end", () => {
    expect(enumerateActivationVisits({
      startDate: d("2026-10-30"), cycleEndDate: d("2026-11-02"), defaultDay: "MON", frequency: "FOUR_WEEKLY",
    })).toEqual([]);
  });

  it("count equals floor-style arithmetic for random windows", () => {
    const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
    const freqs = ["FOUR_WEEKLY", "SIX_WEEKLY", "EIGHT_WEEKLY", "TWELVE_WEEKLY"] as const;
    for (let i = 0; i < 200; i++) {
      const start = addWeeks(d("2026-01-05"), i % 30);
      start.setUTCDate(start.getUTCDate() + (i % 7));
      const cycleWeeks = 4 + (i % 20);
      const end = addWeeks(start, cycleWeeks);
      const day = days[i % 7];
      const freq = freqs[i % 4];
      const first = nextOccurrenceOfDay(start, day);
      const span = (end.getTime() - first.getTime()) / 86_400_000;
      const expected = span <= 0 ? 0 : Math.ceil(span / (frequencyWeeks(freq) * 7));
      expect(enumerateActivationVisits({ startDate: start, cycleEndDate: end, defaultDay: day, frequency: freq }))
        .toHaveLength(expected);
    }
  });
});
