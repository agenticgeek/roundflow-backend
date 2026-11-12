import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
vi.mock("../prisma", () => ({ prisma: { profile: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

import { categoryPushEnabled, isPushEnabledFor } from "../notification-prefs";

beforeEach(() => vi.clearAllMocks());

describe("categoryPushEnabled", () => {
  it("is on for missing or malformed preferences", () => {
    for (const p of [null, undefined, "x", {}, { notifications: null }, { notifications: {} }, { notifications: { categories: 3 } }]) {
      expect(categoryPushEnabled(p, "CHAT")).toBe(true);
    }
  });

  it("is off only when the category is explicitly false", () => {
    const prefs = { notifications: { categories: { CHAT: false, SCHEDULE: true } } };
    expect(categoryPushEnabled(prefs, "CHAT")).toBe(false);
    expect(categoryPushEnabled(prefs, "SCHEDULE")).toBe(true);
    expect(categoryPushEnabled(prefs, "PAYMENT")).toBe(true);
  });
});

describe("isPushEnabledFor", () => {
  it("reads the profile's preferences", async () => {
    findUnique.mockResolvedValue({ preferences: { notifications: { categories: { CHAT: false } } } });
    expect(await isPushEnabledFor("p1", "CHAT")).toBe(false);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { preferences: true } });
  });

  it("is on when the profile is missing", async () => {
    findUnique.mockResolvedValue(null);
    expect(await isPushEnabledFor("p1", "CHAT")).toBe(true);
  });

  it("fails open and logs when the lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockRejectedValue(new Error("db"));
    expect(await isPushEnabledFor("p1", "CHAT")).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
