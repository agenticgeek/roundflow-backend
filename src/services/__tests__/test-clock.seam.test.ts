import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RoundStatus } from "../../generated/tenant-client";

const generateForRound = vi.fn();
vi.mock("../../jobs/visitGeneration", async (orig) => ({
  ...(await orig<typeof import("../../jobs/visitGeneration")>()),
  generateForRound: (...a: unknown[]) => generateForRound(...a),
}));

import { createRoundService } from "../round.service";
import { tenantToday, tenantTodayRange } from "../business-time";
import { runWithClock } from "../../lib/clock";

const saved = { flag: process.env.ALLOW_TEST_CLOCK, env: process.env.NODE_ENV };
afterEach(() => {
  if (saved.flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
  else process.env.ALLOW_TEST_CLOCK = saved.flag;
  process.env.NODE_ENV = saved.env;
  vi.useRealTimers();
});
beforeEach(() => generateForRound.mockReset().mockResolvedValue(3));

const at = new Date("2031-07-09T10:30:00.000Z");
const tp = () => ({ businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "UTC" }) } }) as never;

function roundPrisma() {
  return {
    round: { findUnique: vi.fn().mockResolvedValue({ id: "r1", frequency: "FOUR_WEEKLY", defaultDay: null, status: RoundStatus.ACTIVE }) },
  } as never;
}

describe("seam with the flag on", () => {
  beforeEach(() => {
    process.env.ALLOW_TEST_CLOCK = "1";
    process.env.NODE_ENV = "test";
  });

  it("tenantToday follows the test clock", async () => {
    const d = await runWithClock(at, () => tenantToday(tp()));
    expect(d.toISOString()).toBe("2031-07-09T00:00:00.000Z");
  });

  it("tenantTodayRange follows the test clock", async () => {
    const r = await runWithClock(at, () => tenantTodayRange(tp()));
    expect(r.start.toISOString()).toBe("2031-07-09T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2031-07-10T00:00:00.000Z");
  });

  it("an explicit now argument still wins", async () => {
    const d = await runWithClock(at, () => tenantToday(tp(), new Date("2040-01-01T12:00:00.000Z")));
    expect(d.toISOString()).toBe("2040-01-01T00:00:00.000Z");
  });

  it("generateVisitsNow generates for the test day (UTC midnight)", async () => {
    const result = await runWithClock(at, () => createRoundService(roundPrisma()).generateVisitsNow("r1"));
    expect(result).toEqual({ visitsGenerated: 3 });
    expect((generateForRound.mock.calls[0][2] as Date).toISOString()).toBe("2031-07-09T00:00:00.000Z");
  });
});

describe.each([
  ["flag unset", undefined, "test"],
  ["NODE_ENV=production with the flag set", "1", "production"],
])("seam is inert (%s)", (_label, flag, nodeEnv) => {
  beforeEach(() => {
    if (flag === undefined) delete process.env.ALLOW_TEST_CLOCK;
    else process.env.ALLOW_TEST_CLOCK = flag;
    process.env.NODE_ENV = nodeEnv;
  });

  it("tenantToday / tenantTodayRange / generateVisitsNow use the real date", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T12:00:00.000Z"), toFake: ["Date"] });
    const d = await runWithClock(at, () => tenantToday(tp()));
    expect(d.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    const r = await runWithClock(at, () => tenantTodayRange(tp()));
    expect(r.start.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    await runWithClock(at, () => createRoundService(roundPrisma()).generateVisitsNow("r1"));
    expect((generateForRound.mock.calls[0][2] as Date).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  });
});
