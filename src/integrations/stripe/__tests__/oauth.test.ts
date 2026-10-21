import { describe, it, expect, vi, afterEach } from "vitest";
import { buildStripeAuthUrl, exchangeStripeCode } from "../oauth";

describe("buildStripeAuthUrl", () => {
  it("builds the Stripe Connect authorize URL with client id, scope, and state", () => {
    const url = buildStripeAuthUrl("tenant-1:abc123");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe(process.env.STRIPE_CLIENT_ID);
    expect(parsed.searchParams.get("scope")).toBe("read_write");
    expect(parsed.searchParams.get("state")).toBe("tenant-1:abc123");
  });
});

describe("exchangeStripeCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the authorization code and returns the parsed token response", async () => {
    const tokenResponse = {
      access_token: "acct_token",
      stripe_user_id: "acct_123",
      stripe_publishable_key: "pk_test_123",
      livemode: false,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(tokenResponse),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeStripeCode("ac_code_123");

    expect(result).toEqual(tokenResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://connect.stripe.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        }),
      })
    );
    const call = fetchMock.mock.calls[0][1] as RequestInit;
    expect(String(call.body)).toContain("grant_type=authorization_code");
    expect(String(call.body)).toContain("code=ac_code_123");
  });

  it("throws with the response status and body when the exchange fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeStripeCode("bad_code")).rejects.toThrow(
      /Stripe Connect token exchange failed \(400\): \{"error":"invalid_grant"\}/
    );
  });
});
