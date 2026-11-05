// Business time (EMU-6). Visit dates are stored as UTC-midnight date-only
// values, so "today" must be the business's local calendar date (default
// Europe/London, BusinessSettings.timezone when set) rendered as a UTC
// midnight — not the UTC date of the server clock, which is a day behind for
// UK summer-time evenings between 00:00 and 01:00 local.

export const DEFAULT_TIMEZONE = "Europe/London";

/** Falls back to Europe/London for a missing or unknown IANA zone. */
export function resolveTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Wall-clock date (YYYY-MM-DD) and time (HH:mm) of `now` in `timeZone`. */
export function localDateTime(now: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** UTC-midnight Date for the local calendar day of `now` in `timeZone`. */
export function localDay(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): Date {
  return new Date(`${localDateTime(now, resolveTimeZone(timeZone)).date}T00:00:00.000Z`);
}

export function todayRange(
  timeZone: string = DEFAULT_TIMEZONE,
  now: Date = new Date()
): { start: Date; end: Date } {
  const start = localDay(timeZone, now);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
