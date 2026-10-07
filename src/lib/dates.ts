export function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
