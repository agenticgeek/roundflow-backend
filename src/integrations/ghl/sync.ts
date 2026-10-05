import { getGhlToken, createGhlContact, updateGhlContact, sendGhlMessage } from "./api";

type TP = import("../../lib/tenant-prisma-manager").TenantPrismaClient;

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

export async function syncCustomerToGhl(tp: TP, customerId: string): Promise<void> {
  const ctx = await getGhlToken(tp);
  if (!ctx) return; // GHL not connected for this tenant

  const customer = await tp.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, phone: true, email: true, ghlContactId: true },
  });
  if (!customer) return;

  if (customer.ghlContactId) {
    await updateGhlContact(ctx, customer.ghlContactId, customer);
  } else {
    const contactId = await createGhlContact(ctx, customer);
    await tp.customer.update({
      where: { id: customerId },
      data:  { ghlContactId: contactId },
    });
  }
}
