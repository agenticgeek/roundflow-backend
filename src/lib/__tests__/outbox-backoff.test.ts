import { describe, expect, it } from "vitest";
import { OUTBOX_BACKOFF_MS, OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "../outbox-backoff";

describe("outbox back-off (BE-12)", () => {
  it("waits 30 s, 2 min, 10 min, 1 h, 6 h and is dead on the 6th failure", () => {
    expect([1, 2, 3, 4, 5].map(outboxBackoffMs)).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
    expect(OUTBOX_BACKOFF_MS).toHaveLength(5);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(6);
  });

  it("is clamped for out-of-range inputs", () => {
    expect(outboxBackoffMs(0)).toBe(30_000);
    expect(outboxBackoffMs(99)).toBe(21_600_000);
  });
});
