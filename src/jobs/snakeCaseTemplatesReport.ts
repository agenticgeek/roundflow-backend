import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";
import { forEachTenant, type TenantResult } from "./backfills";
import { PLACEHOLDER_ALIASES } from "../services/message-templates";

// Read-only report: message templates that still hold snake_case placeholder
// aliases ({{customer_name}} ...). Nothing is rewritten - saving the template
// normalises it, and rendering already tolerates the old spelling.

export interface SnakeCaseTemplateRow {
  templateId: string;
  name: string;
  channel: string | null;
  tokens: string[]; // the alias spellings found, e.g. ["customer_name"]
}

export function findAliasTokens(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? "").matchAll(/\{\{\s*([\w.]*)\s*\}\}/g)) {
      if (m[1] in PLACEHOLDER_ALIASES) found.add(m[1]);
    }
  }
  return [...found];
}

export async function listSnakeCaseTemplatesForTenant(tp: TenantPrismaClient): Promise<SnakeCaseTemplateRow[]> {
  const templates = await tp.messageTemplate.findMany({
    select: { id: true, name: true, channel: true, subject: true, body: true },
    orderBy: { createdAt: "asc" },
  });
  return templates
    .map((t) => ({ templateId: t.id, name: t.name, channel: t.channel, tokens: findAliasTokens(t.body, t.subject) }))
    .filter((t) => t.tokens.length > 0);
}

export function listSnakeCaseTemplates(): Promise<TenantResult<SnakeCaseTemplateRow[]>[]> {
  return forEachTenant((tp) => listSnakeCaseTemplatesForTenant(tp));
}
