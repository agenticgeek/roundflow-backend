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

  const failWith = (status: number, body: string) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, text: () => Promise.resolve(body) }));

  it("a rejected code is a 400 STRIPE_CONNECT_FAILED with Stripe's reason, not a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failWith(400, '{"error":"invalid_grant","error_description":"Authorization code does not exist: ac_x"}');
    await expect(exchangeStripeCode("ac_x")).rejects.toMatchObject({
      statusCode: 400,
      code: "STRIPE_CONNECT_FAILED",
      message: "Stripe didn't accept the connection: Authorization code does not exist: ac_x",
    });
    failWith(400, '{"error":"invalid_grant"}');
    await expect(exchangeStripeCode("ac_y")).rejects.toMatchObject({ message: "Stripe didn't accept the connection: invalid_grant" });
    failWith(401, "not json");
    await expect(exchangeStripeCode("ac_z")).rejects.toMatchObject({ message: "Stripe didn't accept the connection: not json" });
    failWith(400, "");
    await expect(exchangeStripeCode("ac_w")).rejects.toMatchObject({ message: "Stripe didn't accept the connection: unknown error" });
    failWith(400, "{}");
    await expect(exchangeStripeCode("ac_v")).rejects.toMatchObject({ message: "Stripe didn't accept the connection: {}" });
  });

  it("a Stripe outage is a 502 STRIPE_UNAVAILABLE", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failWith(503, "upstream");
    await expect(exchangeStripeCode("ac_x")).rejects.toMatchObject({ statusCode: 502, code: "STRIPE_UNAVAILABLE" });
  });
});
