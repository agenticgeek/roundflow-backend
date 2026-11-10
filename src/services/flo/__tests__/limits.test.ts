import { describe, expect, it, vi } from "vitest";
import {
  dailyLimitPerTenant, declineLimitPerDay, floEnabled, floLimiterConfig, getDailyUsage, getDeclineCount, retentionDays, tenantDayWindow,
} from "../limits";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

function fakeTp(timezone: string | null, count = 0) {
  const counts = vi.fn(async () => count);
  const tp = {
    businessSettings: { findFirst: vi.fn(async () => (timezone === null ? null : { timezone })) },
    floMessage: { count: counts },
  };
  return { tp: tp as never, counts };
}

describe("env-owned limits (platform, not tenant)", () => {
  it("applies defaults and overrides", () => {
    expect(dailyLimitPerTenant(env({}))).toBe(100);
    expect(dailyLimitPerTenant(env({ FLO_DAILY_LIMIT_PER_TENANT: "250" }))).toBe(250);
    expect(dailyLimitPerTenant(env({ FLO_DAILY_LIMIT_PER_TENANT: "0" }))).toBe(100);
    expect(dailyLimitPerTenant(env({ FLO_DAILY_LIMIT_PER_TENANT: "abc" }))).toBe(100);
    expect(declineLimitPerDay(env({}))).toBe(30);
    expect(declineLimitPerDay(env({ FLO_DECLINE_LIMIT_PER_DAY: "5" }))).toBe(5);
    expect(retentionDays(env({}))).toBe(90);
    expect(retentionDays(env({ FLO_RETENTION_DAYS: "30" }))).toBe(30);
    expect(floLimiterConfig(env({}))).toEqual({ windowMs: 60_000, max: 20, keyBy: "profile" });
    expect(floLimiterConfig(env({ RATE_LIMIT_FLO_PER_MIN: "7" })).max).toBe(7);
    expect(typeof dailyLimitPerTenant()).toBe("number");
    expect(typeof declineLimitPerDay()).toBe("number");
    expect(typeof retentionDays()).toBe("number");
    expect(floLimiterConfig().keyBy).toBe("profile");
  });

  it("is enabled only with a key and without the kill switch", () => {
    expect(floEnabled(env({}))).toBe(false);
    expect(floEnabled(env({ ANTHROPIC_API_KEY: "  " }))).toBe(false);
    expect(floEnabled(env({ ANTHROPIC_API_KEY: "k" }))).toBe(true);
    expect(floEnabled(env({ ANTHROPIC_API_KEY: "k", FLO_ENABLED: "FALSE" }))).toBe(false);
    expect(floEnabled(env({ ANTHROPIC_API_KEY: "k", FLO_ENABLED: "true" }))).toBe(true);
    expect(typeof floEnabled()).toBe("boolean");
  });
});

describe("tenantDayWindow (tenant-local day)", () => {
  it("is the London calendar day in summer (BST)", () => {
    const w = tenantDayWindow("Europe/London", new Date("2026-07-15T12:00:00Z"));
    expect(w.date).toBe("2026-07-15");
    expect(w.start.toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-15T23:00:00.000Z");
  });

  it("flips exactly at tenant-local midnight, not UTC midnight", () => {
    const before = tenantDayWindow("Europe/London", new Date("2026-07-15T22:59:59Z"));
    expect(before.date).toBe("2026-07-15");
    expect(before.end.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    const at = tenantDayWindow("Europe/London", new Date("2026-07-15T23:00:00Z"));
    expect(at.date).toBe("2026-07-16");
    expect(at.start.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    // 00:30 UTC in summer is 01:30 BST on the same UTC date.
    expect(tenantDayWindow("Europe/London", new Date("2026-07-15T00:30:00Z")).date).toBe("2026-07-15");
  });

  it("handles the 25-hour and 23-hour DST days", () => {
    const fall = tenantDayWindow("Europe/London", new Date("2026-10-25T12:00:00Z"));
    expect(fall.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(fall.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    const spring = tenantDayWindow("Europe/London", new Date("2026-03-29T12:00:00Z"));
    expect(spring.start.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("supports half-hour zones and falls back to London for an unknown zone", () => {
    const ist = tenantDayWindow("Asia/Kolkata", new Date("2026-11-10T18:29:00Z"));
    expect(ist.date).toBe("2026-11-10");
    expect(ist.start.toISOString()).toBe("2026-11-09T18:30:00.000Z");
    expect(ist.end.toISOString()).toBe("2026-11-10T18:30:00.000Z");
    expect(tenantDayWindow("Not/AZone", new Date("2026-01-05T10:00:00Z")).start.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });
});

describe("usage counters", () => {
  it("counts ASSISTANT/OK rows in the tenant-local day and reports remaining + reset", async () => {
    const { tp, counts } = fakeTp("Europe/London", 97);
    const now = new Date("2026-07-15T22:30:00Z");
    const u = await getDailyUsage(tp, now, env({ FLO_DAILY_LIMIT_PER_TENANT: "100" }));
    expect(u).toMatchObject({ used: 97, limit: 100, remaining: 3 });
    expect(u.resetsAt.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    expect(counts).toHaveBeenCalledWith({
      where: { role: "ASSISTANT", status: "OK", createdAt: { gte: new Date("2026-07-14T23:00:00Z"), lt: new Date("2026-07-15T23:00:00Z") } },
    });
  });

  it("never reports negative remaining and uses London when settings are missing; defaults now/env", async () => {
    const { tp } = fakeTp(null, 150);
    const u = await getDailyUsage(tp);
    expect(u.remaining).toBe(0);
    expect(u.limit).toBeGreaterThan(0);
  });

  it("counts DECLINED rows per admin in the tenant-local day", async () => {
    const { tp, counts } = fakeTp("Europe/London", 4);
    expect(await getDeclineCount(tp, "p1", new Date("2026-01-10T12:00:00Z"))).toBe(4);
    expect(counts).toHaveBeenCalledWith({
      where: { role: "ASSISTANT", status: "DECLINED", declineReason: { not: "CAPABILITY" }, createdAt: { gte: new Date("2026-01-10T00:00:00Z"), lt: new Date("2026-01-11T00:00:00Z") }, conversation: { profileId: "p1" } },
    });
    expect(await getDeclineCount(tp, "p1")).toBe(4);
  });
});
