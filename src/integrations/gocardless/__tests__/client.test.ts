import { describe, it, expect, vi } from "vitest";

const GoCardlessClient = vi.fn().mockImplementation(function (this: unknown, accessToken: string, environment: string) {
  return { accessToken, environment };
});

vi.mock("gocardless-nodejs", () => ({
  GoCardlessClient,
  Environments: { Live: "LIVE", Sandbox: "SANDBOX" },
}));

describe("getGcClient", () => {
  it("uses the Live environment when environment === 'live'", async () => {
    const { getGcClient } = await import("../client.js");
    getGcClient("token-123", "live");
    expect(GoCardlessClient).toHaveBeenCalledWith("token-123", "LIVE");
  });

  it("uses the Sandbox environment for anything else", async () => {
    const { getGcClient } = await import("../client.js");
    getGcClient("token-123", "sandbox");
    expect(GoCardlessClient).toHaveBeenCalledWith("token-123", "SANDBOX");
  });
});
