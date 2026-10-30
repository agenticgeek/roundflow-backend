import { it, expect } from "vitest";
import { toBusinessSettingsDto } from "../settings-dto";

const row = {
  id: "bs1",
  businessName: "Coates Windows",
  vatRate: { toString: () => "17.50" },
  gocardlessAccessTokenEncrypted: "gc-token",
  gocardlessWebhookSecretEncrypted: "gc-route",
  gocardlessWebhookSigningSecretEncrypted: "gc-sign",
  stripeSecretKeyEncrypted: "sk",
  ghlAccessTokenEncrypted: "ghl-at",
  ghlRefreshTokenEncrypted: "ghl-rt",
  ghlWebhookSecretEncrypted: "ghl-wh",
  futureThingEncrypted: "new-secret",
  ghlConnected: true,
} as never;

it("strips every *Encrypted field and converts vatRate to a number", () => {
  const dto = toBusinessSettingsDto(row) as unknown as Record<string, unknown>;
  expect(dto).toEqual({ id: "bs1", businessName: "Coates Windows", vatRate: 17.5, ghlConnected: true });
  expect(JSON.stringify(dto)).not.toMatch(/Encrypted|gc-token|ghl-at|sk"/);
});

it("passes null through", () => {
  expect(toBusinessSettingsDto(null)).toBeNull();
});
