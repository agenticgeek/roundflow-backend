import {
  getGhlToken, createGhlContact, updateGhlContact, sendGhlMessage, addGhlTags, removeGhlTags,
  setGhlContactCustomFields,
} from "./api";

type TP = import("../../lib/tenant-prisma-manager").TenantPrismaClient;

// Write an outbox row — worker drains these every 30s and calls GHL. `extra`
// merges into the payload alongside customerId — e.g. visitId, so the worker
// can look up round/technician names at drain time without re-deriving them.
export async function queueGhlEvent(
  tp: TP,
  eventType: string,
  customerId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await tp.integrationOutbox.create({ data: { eventType, payload: { customerId, ...extra } } });
}

// Called by the outbox worker — still used directly for complaint messages since
// those need the message body at send time.
export async function syncMessageToGhl(tp: TP, complaintId: string, body: string, channel: string): Promise<void> {
  const ctx = await getGhlToken(tp);
  if (!ctx) return;

  const complaint = await tp.complaint.findUnique({
    where: { id: complaintId },
    select: { customer: { select: { ghlContactId: true } } },
  });
  const contactId = complaint?.customer?.ghlContactId;
  if (!contactId) return;

  await sendGhlMessage(ctx, contactId, body, channel);
}

// Called by the outbox worker for customer.synced rows.
export async function syncCustomerToGhl(tp: TP, customerId: string): Promise<void> {
  const ctx = await getGhlToken(tp);
  if (!ctx) return;

  const customer = await tp.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, phone: true, email: true, ghlContactId: true },
  });
  if (!customer) return;

  if (customer.ghlContactId) {
    await updateGhlContact(ctx, customer.ghlContactId, customer);
  } else {
    const contactId = await createGhlContact(ctx, customer);
    await tp.customer.update({ where: { id: customerId }, data: { ghlContactId: contactId } });
  }
}

// Called by the outbox worker for tag-based events.
export async function applyGhlTags(
  tp: TP,
  customerId: string,
  tagsToAdd: string[],
  tagsToRemove: string[] = [],
): Promise<void> {
  const ctx = await getGhlToken(tp);
  if (!ctx) return;

  const customer = await tp.customer.findUnique({
    where: { id: customerId },
    select: { ghlContactId: true },
  });
  if (!customer?.ghlContactId) return;

  if (tagsToAdd.length)    await addGhlTags(ctx, customer.ghlContactId, tagsToAdd);
  if (tagsToRemove.length) await removeGhlTags(ctx, customer.ghlContactId, tagsToRemove);
}

// Called by the outbox worker to write the custom fields listed in
// docs/GHL_AUTOMATION_OWNER_HANDOFF.md §1 (last_clean_date, next_clean_date,
// balance_owed, round_name, technician_name).
export async function applyGhlCustomFields(
  tp: TP,
  customerId: string,
  fields: Record<string, string | number>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;

  const ctx = await getGhlToken(tp);
  if (!ctx) return;

  const customer = await tp.customer.findUnique({
    where: { id: customerId },
    select: { ghlContactId: true },
  });
  if (!customer?.ghlContactId) return;

  await setGhlContactCustomFields(ctx, customer.ghlContactId, fields);
}
