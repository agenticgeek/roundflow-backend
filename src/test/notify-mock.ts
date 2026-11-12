import { vi } from "vitest";

// Shared stub for `vi.mock("<path>/services/notify", ...)` in tests of code that
// merely CALLS the notifier. Notification behaviour itself is tested in
// src/services/__tests__/notify.test.ts. Use:
//   vi.mock("../notify", async () => (await import("../../test/notify-mock.js")).notifyMockModule());
export function notifyMockModule() {
  return {
    notifyEvent: vi.fn().mockResolvedValue(0),
    notifyAdmins: vi.fn().mockResolvedValue(0),
    notifyTenantAdmins: vi.fn().mockResolvedValue(0),
    notifyVisitTechnicians: vi.fn().mockResolvedValue(undefined),
    notifyInvoicePaid: vi.fn().mockResolvedValue(undefined),
    notifyPaymentFailed: vi.fn().mockResolvedValue(undefined),
    notifyPaymentEvent: vi.fn().mockResolvedValue(undefined),
    notifyIntegrationDead: vi.fn().mockResolvedValue(undefined),
    visitCount: (n: number) => `${n} ${n === 1 ? "visit" : "visits"}`,
  };
}
