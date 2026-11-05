// Per-row validation error for bulk imports (setup step 9 bulk, GAP-009).
// `error` is the contract field; `message` carries the same text for one
// release so existing clients that read it keep working.
export interface RowError {
  row: number; // 0-based index into the submitted array
  field: string;
  error: string;
  message: string;
}

export function rowError(row: number, field: string, error: string): RowError {
  return { row, field, error, message: error };
}
