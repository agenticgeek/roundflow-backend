import type { BusinessSettings } from "../generated/tenant-client";
import { parseStoredReminders, type PreCleanReminder } from "./settings-validators";

// D-1: BusinessSettings carries the encrypted OAuth/API tokens and webhook
// secrets for GHL, Stripe and GoCardless. Every endpoint that returns the row
// (GET/PATCH /settings/*, GET/POST /setup/step/1|2|4) goes through this mapper
// so the ciphertexts never leave the server. Decimal columns the web needs as
// numbers (vatRate) are converted here too.

type SecretKey =
  | "gocardlessAccessTokenEncrypted"
  | "gocardlessWebhookSecretEncrypted"
  | "gocardlessWebhookSigningSecretEncrypted"
  | "stripeSecretKeyEncrypted"
  | "ghlAccessTokenEncrypted"
  | "ghlRefreshTokenEncrypted"
  | "ghlWebhookSecretEncrypted";

export type BusinessSettingsDto = Omit<BusinessSettings, SecretKey | "vatRate" | "preCleanReminders"> & {
  vatRate: number;
  /** BUG-01: always a clean [{ type, time }] list (legacy rows fall back to reminderMode/reminderTime). */
  preCleanReminders: PreCleanReminder[];
};

export function toBusinessSettingsDto(bs: BusinessSettings): BusinessSettingsDto;
export function toBusinessSettingsDto(bs: BusinessSettings | null): BusinessSettingsDto | null;
export function toBusinessSettingsDto(bs: BusinessSettings | null): BusinessSettingsDto | null {
  if (!bs) return null;
  const {
    gocardlessAccessTokenEncrypted: _gcToken,
    gocardlessWebhookSecretEncrypted: _gcRouteSecret,
    gocardlessWebhookSigningSecretEncrypted: _gcSigningSecret,
    stripeSecretKeyEncrypted: _stripeKey,
    ghlAccessTokenEncrypted: _ghlToken,
    ghlRefreshTokenEncrypted: _ghlRefresh,
    ghlWebhookSecretEncrypted: _ghlSecret,
    vatRate,
    preCleanReminders,
    ...rest
  } = bs;
  // Any column named *Encrypted that a future migration adds is stripped too,
  // so a new secret can't leak just because this list wasn't updated.
  for (const key of Object.keys(rest)) {
    if (key.endsWith("Encrypted")) delete (rest as Record<string, unknown>)[key];
  }
  return {
    ...rest,
    vatRate: Number(vatRate),
    preCleanReminders: parseStoredReminders(preCleanReminders, bs.reminderMode, bs.reminderTime),
  };
}
