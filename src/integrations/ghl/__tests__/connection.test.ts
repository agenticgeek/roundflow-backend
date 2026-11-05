import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchGhlLocation,
  ghlApiRedirectUri,
  ghlWebhookUrl,
  frontendBaseUrl,
  isAllowedWebRedirect,
} from "../connection";

const fetchMock = vi.fn();
const env = { ...process.env };
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  process.env.PUBLIC_API_URL = "https://api.test";
  process.env.FRONTEND_URL = "https://app.test, http://localhost:5173 ,";
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

const res = (status: number, body: unknown) =>
  ({
    ok: status < 400,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    json: () => (typeof body === "string" ? Promise.reject(new Error("not json")) : Promise.resolve(body)),
  }) as unknown as Response;

it("fetchGhlLocation returns the location name with the token as bearer", async () => {
  fetchMock.mockResolvedValue(res(200, { location: { name: "Coates Windows" } }));
  await expect(fetchGhlLocation("tok", "loc/1")).resolves.toEqual({ ok: true, locationName: "Coates Windows" });
  expect(fetchMock).toHaveBeenCalledWith("https://services.leadconnectorhq.com/locations/loc%2F1", {
    headers: { Authorization: "Bearer tok", Version: "2021-07-28" },
  });
});

it("fetchGhlLocation tolerates a body without a name or an unparseable body", async () => {
  fetchMock.mockResolvedValueOnce(res(200, {}));
  await expect(fetchGhlLocation("t", "l")).resolves.toEqual({ ok: true, locationName: null });
  fetchMock.mockResolvedValueOnce(res(200, "<html>"));
  await expect(fetchGhlLocation("t", "l")).resolves.toEqual({ ok: true, locationName: null });
});

it("fetchGhlLocation maps GHL errors to { ok: false } with GHL's message", async () => {
  fetchMock.mockResolvedValueOnce(res(401, { message: "Invalid JWT" }));
  await expect(fetchGhlLocation("t", "l")).resolves.toEqual({ ok: false, status: 401, message: "Invalid JWT" });
  fetchMock.mockResolvedValueOnce(res(422, { message: ["a", "b"] }));
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ message: "a, b" });
  fetchMock.mockResolvedValueOnce(res(403, { error: "Forbidden" }));
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ message: "Forbidden" });
  fetchMock.mockResolvedValueOnce(res(500, { code: 1 }));
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ message: '{"code":1}' });
  fetchMock.mockResolvedValueOnce(res(502, "Bad gateway"));
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ status: 502, message: "Bad gateway" });
  fetchMock.mockResolvedValueOnce(res(503, ""));
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ message: "GHL responded 503" });
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.reject(new Error("x")) });
  await expect(fetchGhlLocation("t", "l")).resolves.toMatchObject({ message: "GHL responded 500" });
});

it("fetchGhlLocation never throws on network errors", async () => {
  fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
  await expect(fetchGhlLocation("t", "l")).resolves.toEqual({ ok: false, status: 0, message: "ECONNRESET" });
  fetchMock.mockRejectedValueOnce("boom");
  await expect(fetchGhlLocation("t", "l")).resolves.toEqual({ ok: false, status: 0, message: "boom" });
});

it("builds the API redirect URI, webhook URL and frontend base", () => {
  expect(ghlApiRedirectUri()).toBe("https://api.test/settings/ghl/callback");
  expect(ghlWebhookUrl("t1", "s3")).toBe("https://api.test/webhooks/ghl?tenantId=t1&secret=s3");
  expect(frontendBaseUrl()).toBe("https://app.test");
  delete process.env.FRONTEND_URL;
  expect(frontendBaseUrl()).toBe("");
});

it("isAllowedWebRedirect only allows FRONTEND_URL origins", () => {
  expect(isAllowedWebRedirect("https://app.test/settings/ghl/callback")).toBe(true);
  expect(isAllowedWebRedirect("http://localhost:5173/cb")).toBe(true);
  expect(isAllowedWebRedirect("https://evil.test/cb")).toBe(false);
  expect(isAllowedWebRedirect("not a url")).toBe(false);
  process.env.FRONTEND_URL = "not-a-url,https://app.test";
  expect(isAllowedWebRedirect("https://app.test/x")).toBe(true);
  delete process.env.FRONTEND_URL;
  expect(isAllowedWebRedirect("https://app.test/x")).toBe(false);
});
