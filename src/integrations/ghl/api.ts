import { encrypt, decrypt } from "../../lib/crypto";
import { refreshGhlToken } from "./oauth";

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

export async function sendGhlMessage(
  ctx: GhlTokenContext,
  contactId: string,
  messageBody: string,
  channel: string
): Promise<void> {
  const type = CHANNEL_TYPE_MAP[channel] ?? "Email";
  const res = await fetch(`${GHL_API}/conversations/messages`, {
    method: "POST",
    headers: ghlHeaders(ctx.accessToken, "2021-04-15"),
    body: JSON.stringify({ type, contactId, message: messageBody }),
  });
  await assertGhlOk(res, "sendMessage");
}
