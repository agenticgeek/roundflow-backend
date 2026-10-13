import { AppError } from "./app-error";

// Shallow-merge incoming keys into a user's stored preferences blob. A null or
// non-object existing value is treated as empty. Caps the result at 100KB.
export function mergePreferences(
  existing: unknown,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const merged = { ...base, ...incoming };
  // ponytail: flat 100KB cap so a client can't bloat its row; raise if a real need appears.
  if (JSON.stringify(merged).length > 100_000) {
    throw new AppError(400, "preferences payload too large (max 100KB)");
  }
  return merged;
}
