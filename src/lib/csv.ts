// Minimal RFC-4180-ish CSV serialiser. Headers come from the first row's keys.
// Quotes any field containing a comma, quote, or newline; Dates render as ISO.
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((hdr) => esc(r[hdr])).join(",")),
  ].join("\n");
}
