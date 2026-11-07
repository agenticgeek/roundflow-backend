// BE-19: tenant schema names are interpolated into raw SQL (search_path, CREATE SCHEMA, the migrations table) and
// into the Prisma connection URL, where they cannot be bound as parameters. They are generated as `t_<20 hex>`,
// but every sink re-validates here so a corrupted Tenant row can never become SQL or URL injection.

export const SCHEMA_NAME_PATTERN = /^t_[0-9a-f]{20}$/;

export function isValidSchemaName(name: unknown): name is string {
  return typeof name === "string" && SCHEMA_NAME_PATTERN.test(name);
}

/** Returns `name` unchanged or throws. */
export function assertSchemaName(name: unknown): string {
  if (!isValidSchemaName(name)) throw new Error("Invalid tenant schema name");
  return name;
}

/** `"t_..."` — the validated name as a quoted SQL identifier. */
export function quoteSchema(name: unknown): string {
  return `"${assertSchemaName(name)}"`;
}
