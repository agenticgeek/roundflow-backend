import { it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const deleteMany = vi.fn();
vi.mock("../prisma", () => ({
  prisma: {
    tenantInvite: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));

import { assertNoActiveInvite, buildInviteUrl, newInviteExpiry } from "../invites";
import { AppError } from "../app-error";

beforeEach(() => {
  vi.resetAllMocks();
});

it("newInviteExpiry is 7 days out", () => {
  const days = (newInviteExpiry().getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThan(7.1);
});

it("buildInviteUrl points at the frontend accept-invite page", () => {
  process.env.INVITE_BASE_URL = "https://app.example";
  expect(buildInviteUrl("tok1")).toBe("https://app.example/accept-invite?token=tok1");
});

it("assertNoActiveInvite 409s when an unexpired pending invite exists", async () => {
  findFirst.mockResolvedValue({ id: "inv1" });
  const err = await assertNoActiveInvite("t1", "a@x.com", "dup").catch((e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ statusCode: 409, message: "dup" });
  expect(findFirst).toHaveBeenCalledWith({
    where: { tenantId: "t1", email: "a@x.com", acceptedAt: null, expiresAt: { gt: expect.any(Date) } },
  });
  expect(deleteMany).not.toHaveBeenCalled();
});

it("assertNoActiveInvite clears expired pending invites when none are active", async () => {
  findFirst.mockResolvedValue(null);
  await assertNoActiveInvite("t1", "a@x.com", "dup");
  expect(deleteMany).toHaveBeenCalledWith({
    where: { tenantId: "t1", email: "a@x.com", acceptedAt: null, expiresAt: { lte: expect.any(Date) } },
  });
});
