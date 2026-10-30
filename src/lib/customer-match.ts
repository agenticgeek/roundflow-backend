// GAP-010: one client, many properties. Setup step 9 (single and bulk) reuses
// an existing customer when the mobile number or email matches, instead of
// creating a duplicate per property.

/** Digits only, with UK international forms (+44 / 0044 / 44) folded onto the
 *  national leading 0, so "+44 7700 900201" and "07700900201" compare equal.
 *  Returns null when there are too few digits to be a phone number. */
export function normaliseMobile(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("44")) digits = `0${digits.slice(2)}`;
  return digits.length >= 7 ? digits : null;
}

/** Trimmed, lower-cased email; null when blank. */
export function normaliseEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e === "" ? null : e;
}

type Contact = { phone?: string | null; email?: string | null };

/** In-memory lookup of customer ids by normalised mobile and email. */
export class CustomerIndex {
  private readonly byPhone = new Map<string, string>();
  private readonly byEmail = new Map<string, string>();

  constructor(rows: Array<Contact & { id: string }> = []) {
    for (const r of rows) this.add(r.id, r);
  }

  /** First match wins: an id already indexed under a key is never replaced. */
  add(id: string, contact: Contact): void {
    const phone = normaliseMobile(contact.phone);
    const email = normaliseEmail(contact.email);
    if (phone && !this.byPhone.has(phone)) this.byPhone.set(phone, id);
    if (email && !this.byEmail.has(email)) this.byEmail.set(email, id);
  }

  /** Matching customer id by mobile, then by email; null when neither matches. */
  find(contact: Contact): string | null {
    const phone = normaliseMobile(contact.phone);
    const email = normaliseEmail(contact.email);
    return (phone && this.byPhone.get(phone)) || (email && this.byEmail.get(email)) || null;
  }

  merge(other: CustomerIndex): void {
    for (const [k, v] of other.byPhone) if (!this.byPhone.has(k)) this.byPhone.set(k, v);
    for (const [k, v] of other.byEmail) if (!this.byEmail.has(k)) this.byEmail.set(k, v);
  }
}
