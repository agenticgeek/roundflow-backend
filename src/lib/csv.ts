// Minimal RFC-4180-ish CSV serialiser. Headers come from the first row's keys.
// Quotes any field containing a comma, quote, or newline; Dates render as ISO.
// Generic over any plain-object row shape (not just index-signature types),
// so typed service DTOs (e.g. TechnicianReportRow) can be passed directly.
export function toCsv<T extends object>(rows: T[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]) as (keyof T)[];
  const esc = (v: unknown) => {
    const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((hdr) => esc(r[hdr])).join(",")),
  ].join("\n");
}
