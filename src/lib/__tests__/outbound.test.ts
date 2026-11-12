import { describe, it, expect } from "vitest";
import { DEFAULT_OUTBOUND_TIMEOUT_MS, outboundSignal, outboundTimeoutMs } from "../outbound";

describe("outbound timeouts (BE-09)", () => {
  it("defaults to 15 s and honours OUTBOUND_TIMEOUT_MS when sane", () => {
    expect(outboundTimeoutMs({})).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
    expect(outboundTimeoutMs({ OUTBOUND_TIMEOUT_MS: "5000.9" })).toBe(5000);
    expect(outboundTimeoutMs({ OUTBOUND_TIMEOUT_MS: "10" })).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
    expect(outboundTimeoutMs({ OUTBOUND_TIMEOUT_MS: "abc" })).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
  });

  it("outboundSignal returns a live AbortSignal", () => {
    const s = outboundSignal(1000);
    expect(s.aborted).toBe(false);
    expect(outboundSignal()).toBeInstanceOf(AbortSignal);
  });
});
