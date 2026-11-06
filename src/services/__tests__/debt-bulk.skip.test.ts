import { describe, expect, it, vi } from "vitest";
import { runBulkDebtAction } from "../debt-bulk";
import { AppError } from "../../lib/app-error";
import { ChannelUnavailableError } from "../email.service";

describe("runBulkDebtAction: reminders that cannot be sent are skipped with a reason", () => {
  it("maps opt-out, no channel and no contact to skipped rows", async () => {
    const debt = {
      sendReminder: vi
        .fn()
        .mockResolvedValueOnce({ customerId: "c1" })
        .mockRejectedValueOnce(new AppError(409, "Customer has opted out of messages", "CUSTOMER_OPTED_OUT"))
        .mockRejectedValueOnce(new ChannelUnavailableError("EMAIL_PAUSED", "paused"))
        .mockRejectedValueOnce(new AppError(400, "no contact", "NO_CONTACT_FOR_CHANNEL"))
        .mockRejectedValueOnce(new AppError(404, "Invoice not found")),
    };
    const reminded = vi.fn();
    const res = await runBulkDebtAction(debt as never, ["a", "b", "c", "d", "e"], "remind", { onReminded: reminded });
    expect(reminded).toHaveBeenCalledWith("c1");
    expect(res.results).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "Customer has opted out of messages", code: "CUSTOMER_OPTED_OUT", skipped: true, reason: "CUSTOMER_OPTED_OUT" },
      { id: "c", ok: false, error: "paused", code: "CHANNEL_UNAVAILABLE", skipped: true, reason: "NO_AVAILABLE_CHANNEL" },
      { id: "d", ok: false, error: "no contact", code: "NO_CONTACT_FOR_CHANNEL", skipped: true, reason: "NO_AVAILABLE_CHANNEL" },
      { id: "e", ok: false, error: "Invoice not found" },
    ]);
    expect(res).toMatchObject({ succeeded: 1, failed: 4 });
  });
});
