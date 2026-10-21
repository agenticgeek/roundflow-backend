import { describe, it, expect, vi } from "vitest";
import { createRedirectFlow, completeRedirectFlow } from "../mandate";
import type { GcClient } from "../client";

describe("createRedirectFlow", () => {
  it("creates a BACS redirect flow and returns its id and redirect url", async () => {
    const client = {
      redirectFlows: {
        create: vi.fn().mockResolvedValue({
          id: "RE123",
          redirect_url: "https://pay-sandbox.gocardless.com/flow/RE123",
        }),
      },
    } as unknown as GcClient;

    const result = await createRedirectFlow(client, {
      successRedirectUrl: "https://app.test/mandate/success",
      sessionToken: "cust-1",
      description: "Direct Debit for window cleaning",
    });

    expect(client.redirectFlows.create).toHaveBeenCalledWith({
      session_token: "cust-1",
      success_redirect_url: "https://app.test/mandate/success",
      scheme: "bacs",
      description: "Direct Debit for window cleaning",
    });
    expect(result).toEqual({ id: "RE123", redirectUrl: "https://pay-sandbox.gocardless.com/flow/RE123" });
  });
});

describe("completeRedirectFlow", () => {
  it("completes the flow and returns the gocardless customer and mandate ids", async () => {
    const client = {
      redirectFlows: {
        complete: vi.fn().mockResolvedValue({
          links: { customer: "CU123", mandate: "MD123" },
        }),
      },
    } as unknown as GcClient;

    const result = await completeRedirectFlow(client, "RE123", "cust-1");

    expect(client.redirectFlows.complete).toHaveBeenCalledWith("RE123", { session_token: "cust-1" });
    expect(result).toEqual({ gcCustomerId: "CU123", mandateId: "MD123" });
  });
});
