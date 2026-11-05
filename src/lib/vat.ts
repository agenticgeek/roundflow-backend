import type { BusinessSettings } from "../generated/tenant-client";

// VAT helpers shared by invoicing, visit completion and the mobile job detail
// so a visit's gross total is computed in exactly one way (A3). Prices on
// visits/plans are net; VAT is only added when BusinessSettings.vatInInvoices.

type VatSettings = Pick<BusinessSettings, "vatInInvoices" | "vatRate"> | null | undefined;

export function round2(n: number): number {
  return +n.toFixed(2);
}

// B1: VAT comes from BusinessSettings.vatRate (default 20%).
export function vatRateOf(settings: VatSettings): number {
  return settings?.vatRate != null ? Number(settings.vatRate) : 20;
}

/** VAT added on top of a net amount. */
export function vatOn(net: number, settings: VatSettings): number {
  return settings?.vatInInvoices ? round2((net * vatRateOf(settings)) / 100) : 0;
}

/** Net + VAT: what the customer owes for a visit priced at `net`. */
export function grossOf(net: number, settings: VatSettings): number {
  return round2(net + vatOn(net, settings));
}
