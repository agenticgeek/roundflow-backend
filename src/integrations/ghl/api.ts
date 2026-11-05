import { encrypt, decrypt } from "../../lib/crypto";
import { refreshGhlToken } from "./oauth";
import { invalidateCachedBusinessSettings } from "../../services/settings.service";

const GHL_API = "https://services.leadconnectorhq.com";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function ghlHeaders(token: string, version = "2021-07-28") {
  return { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "Version": version };
}

async function assertGhlOk(res: Response, label: string): Promise<void> {
  if (!res.ok) throw new Error(`GHL ${label} failed (${res.status}): ${await res.text()}`);
}

type TP = import("../../lib/tenant-prisma-manager").TenantPrismaClient;

export interface GhlTokenContext {
  accessToken: string;
  locationId:  string;
}

export async function getGhlToken(tp: TP): Promise<GhlTokenContext | null> {
  const bs = await tp.businessSettings.findFirst({
    select: {
      ghlConnected:             true,
      ghlLocationId:            true,
      ghlAccessTokenEncrypted:  true,
      ghlRefreshTokenEncrypted: true,
      ghlTokenExpiresAt:        true,
    },
  });

  if (!bs?.ghlConnected || !bs.ghlAccessTokenEncrypted || !bs.ghlLocationId) return null;

  const needsRefresh = (bs.ghlTokenExpiresAt?.getTime() ?? 0) - Date.now() < REFRESH_BUFFER_MS;

  if (needsRefresh && bs.ghlRefreshTokenEncrypted) {
    try {
      const tokens    = await refreshGhlToken(decrypt(bs.ghlRefreshTokenEncrypted));
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000);
      await tp.businessSettings.updateMany({
        data: {
          ghlAccessTokenEncrypted:  encrypt(tokens.access_token),
          ghlRefreshTokenEncrypted: encrypt(tokens.refresh_token),
          ghlTokenExpiresAt:        newExpiry,
        },
      });
      invalidateCachedBusinessSettings(tp);
      return { accessToken: tokens.access_token, locationId: bs.ghlLocationId };
    } catch (err) {
      console.error("[ghl/api] token refresh failed — marking connection dead:", err);
      await tp.businessSettings.updateMany({
        data: {
          ghlConnected:             false,
          ghlAccessTokenEncrypted:  null,
          ghlRefreshTokenEncrypted: null,
          ghlTokenExpiresAt:        null,
        },
      });
      invalidateCachedBusinessSettings(tp);
      return null;
    }
  }

  return { accessToken: decrypt(bs.ghlAccessTokenEncrypted), locationId: bs.ghlLocationId };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const idx = name.indexOf(" ");
  if (idx === -1) return { firstName: name, lastName: "" };
  return { firstName: name.slice(0, idx), lastName: name.slice(idx + 1) };
}

export async function createGhlContact(
  ctx: GhlTokenContext,
  customer: { name: string; phone?: string | null; email?: string | null }
): Promise<string> {
  const { firstName, lastName } = splitName(customer.name);
  const res = await fetch(`${GHL_API}/contacts/`, {
    method: "POST",
    headers: ghlHeaders(ctx.accessToken),
    body: JSON.stringify({ locationId: ctx.locationId, firstName, lastName, phone: customer.phone ?? undefined, email: customer.email ?? undefined }),
  });
  await assertGhlOk(res, "createContact");
  const data = await res.json() as { contact: { id: string } };
  return data.contact.id;
}

export async function updateGhlContact(
  ctx: GhlTokenContext,
  contactId: string,
  customer: { name: string; phone?: string | null; email?: string | null }
): Promise<void> {
  const { firstName, lastName } = splitName(customer.name);
  const res = await fetch(`${GHL_API}/contacts/${contactId}`, {
    method: "PUT",
    headers: ghlHeaders(ctx.accessToken),
    body: JSON.stringify({ firstName, lastName, phone: customer.phone ?? undefined, email: customer.email ?? undefined }),
  });
  await assertGhlOk(res, "updateContact");
}

export async function addGhlTags(ctx: GhlTokenContext, contactId: string, tags: string[]): Promise<void> {
  const res = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: ghlHeaders(ctx.accessToken),
    body: JSON.stringify({ tags }),
  });
  await assertGhlOk(res, "addTags");
}

export async function removeGhlTags(ctx: GhlTokenContext, contactId: string, tags: string[]): Promise<void> {
  const res = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
    method: "DELETE",
    headers: ghlHeaders(ctx.accessToken),
    body: JSON.stringify({ tags }),
  });
  await assertGhlOk(res, "removeTags");
}

const CHANNEL_TYPE_MAP: Record<string, string> = {
  EMAIL:    "Email",
  SMS:      "SMS",
  WHATSAPP: "WhatsApp",
};

// Resolves to GHL's message id once GHL has accepted the message (null if the
// response body carries none). Throws on any non-2xx so callers only record a
// Message row after a real acceptance.
export async function sendGhlMessage(
  ctx: GhlTokenContext,
  contactId: string,
  messageBody: string,
  channel: string
): Promise<string | null> {
  const type = CHANNEL_TYPE_MAP[channel] ?? "Email";
  const res = await fetch(`${GHL_API}/conversations/messages`, {
    method: "POST",
    headers: ghlHeaders(ctx.accessToken, "2021-04-15"),
    body: JSON.stringify({ type, contactId, message: messageBody }),
  });
  await assertGhlOk(res, "sendMessage");
  const data = (await res.json().catch(() => null)) as { messageId?: string } | null;
  return data?.messageId ?? null;
}

// ---------------------------------------------------------------------------
// Custom fields — see docs/GHL_AUTOMATION_OWNER_HANDOFF.md §1 and
// docs/ARCHITECTURE_LATEST.md §10.6. Verified against GHL's official docs
// (marketplace.gohighlevel.com/docs/ghl/locations/get-custom-fields and
// .../docs/ghl/contacts/update-contact): both endpoints require Version
// "v3" — NOT the "2021-07-28" default used by createGhlContact/updateGhlContact
// elsewhere in this file — and the contact PUT body uses {id, key, fieldValue},
// not {id, value}. GHL's own "Create Contact" doc page shows a conflicting
// {id, fieldValue} example without `key`; `key` is included here since the
// "Update Contact" page's worked example shows it alongside `id`.
// ---------------------------------------------------------------------------

interface GhlCustomFieldDef {
  id: string;
  fieldKey: string;
}

const CUSTOM_FIELD_CACHE_TTL_MS = 10 * 60 * 1000;
const customFieldCache = new Map<string, { fields: Map<string, string>; expiresAt: number }>();

// Exposed for tests only — clears the module-level cache between cases.
export function __clearGhlCustomFieldCache(): void {
  customFieldCache.clear();
}

// GHL fieldKeys often come back namespaced (e.g. "contact.last_clean_date") —
// match against the bare key regardless of prefix.
function bareFieldKey(fieldKey: string): string {
  const idx = fieldKey.lastIndexOf(".");
  return idx === -1 ? fieldKey : fieldKey.slice(idx + 1);
}

async function getLocationCustomFields(ctx: GhlTokenContext): Promise<Map<string, string>> {
  const cached = customFieldCache.get(ctx.locationId);
  if (cached && cached.expiresAt > Date.now()) return cached.fields;

  const res = await fetch(`${GHL_API}/locations/${ctx.locationId}/customFields`, {
    headers: ghlHeaders(ctx.accessToken, "v3"),
  });
  await assertGhlOk(res, "getCustomFields");
  const data = (await res.json()) as { customFields: GhlCustomFieldDef[] };

  const fields = new Map(data.customFields.map((f) => [bareFieldKey(f.fieldKey), f.id] as const));
  customFieldCache.set(ctx.locationId, { fields, expiresAt: Date.now() + CUSTOM_FIELD_CACHE_TTL_MS });
  return fields;
}

// Writes contact custom fields by RoundFlow's bare key names (e.g.
// "last_clean_date") — resolves each to GHL's internal field id first. A key
// with no matching field in GHL is skipped (logged), not thrown — the
// automation owner may not have created every field yet.
export async function setGhlContactCustomFields(
  ctx: GhlTokenContext,
  contactId: string,
  fields: Record<string, string | number>
): Promise<void> {
  const fieldMap = await getLocationCustomFields(ctx);

  const customFields = Object.entries(fields).reduce<Array<{ id: string; key: string; fieldValue: string | number }>>(
    (acc, [key, value]) => {
      const id = fieldMap.get(key);
      if (!id) {
        console.warn(`[ghl/api] custom field "${key}" not found in GHL location ${ctx.locationId} — skipping`);
        return acc;
      }
      acc.push({ id, key, fieldValue: value });
      return acc;
    },
    []
  );

  if (customFields.length === 0) return;

  const res = await fetch(`${GHL_API}/contacts/${contactId}`, {
    method: "PUT",
    headers: ghlHeaders(ctx.accessToken, "v3"),
    body: JSON.stringify({ customFields }),
  });
  await assertGhlOk(res, "setCustomFields");
}
