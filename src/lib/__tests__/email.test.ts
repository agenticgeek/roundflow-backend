import { it, expect, vi, beforeEach, afterEach } from "vitest";

// email.ts reads its Supabase env at import time, so each test stubs env and
// re-imports a fresh copy of the module.
async function loadEmail(env: { issuer?: string; key?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("SUPABASE_ISSUER", env.issuer ?? "https://proj.supabase.co/auth/v1");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", env.key ?? "service-key");
  return import("../email.js");
}

const fetchMock = vi.fn();
const reply = (status: number, body = "") =>
  ({ ok: status < 400, status, text: () => Promise.resolve(body) }) as Response;

const INVITE_URL = "https://app.example/accept-invite?token=tok1";
const REDIRECT = `redirect_to=${encodeURIComponent(INVITE_URL)}`;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("throws when the Supabase env is missing", async () => {
  const { sendInviteEmail } = await loadEmail({ key: "" });
  await expect(sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL })).rejects.toThrow(/must be set/);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("throws when SUPABASE_ISSUER is unset", async () => {
  vi.resetModules();
  vi.stubEnv("SUPABASE_ISSUER", undefined as unknown as string);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  const { sendInviteEmail } = await import("../email.js");
  await expect(sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL })).rejects.toThrow(/must be set/);
});

it("sends a Supabase invite with redirect_to in the query string", async () => {
  const { sendInviteEmail } = await loadEmail();
  fetchMock.mockResolvedValue(reply(200));

  await sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`https://proj.supabase.co/auth/v1/invite?${REDIRECT}`);
  expect(init.headers).toMatchObject({ apikey: "service-key", Authorization: "Bearer service-key" });
  expect(JSON.parse(init.body)).toEqual({ email: "a@x.com", data: {} });
});

it("falls back to a magic link when the user already exists", async () => {
  const { sendInviteEmail } = await loadEmail();
  fetchMock
    .mockResolvedValueOnce(reply(422, '{"code":422,"error_code":"email_exists","msg":"A user with this email address has already been registered"}'))
    .mockResolvedValueOnce(reply(200));

  await sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL });

  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe(`https://proj.supabase.co/auth/v1/otp?${REDIRECT}`);
  expect(JSON.parse(init.body)).toEqual({ email: "a@x.com", create_user: false });
});

it("throws when the magic-link fallback fails", async () => {
  const { sendInviteEmail } = await loadEmail();
  fetchMock
    .mockResolvedValueOnce(reply(422, "user_already_exists"))
    .mockResolvedValueOnce(reply(429, "rate limited"));

  await expect(sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL })).rejects.toThrow(
    "Supabase sign-in link failed [429]: rate limited"
  );
});

it("throws on other invite failures without falling back", async () => {
  const { sendInviteEmail } = await loadEmail();
  fetchMock.mockResolvedValue(reply(500, "boom"));

  await expect(sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL })).rejects.toThrow(
    "Supabase invite failed [500]: boom"
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not treat an unrelated 422 as an existing user", async () => {
  const { sendInviteEmail } = await loadEmail();
  fetchMock.mockResolvedValue(reply(422, '{"msg":"invalid email"}'));

  await expect(sendInviteEmail({ to: "a@x.com", inviteUrl: INVITE_URL })).rejects.toThrow(/\[422\]/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
