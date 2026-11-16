import { describe, expect, it, vi } from "vitest";
import { customerLabel, propertyLabel, roundLabel, technicianLabel, visitLabel, visitLabelFrom } from "../activity-labels";

const db = (over: Record<string, unknown> = {}): any => ({
  round: { findUnique: vi.fn().mockResolvedValue({ name: "Fri Round" }) },
  technician: { findUnique: vi.fn().mockResolvedValue({ name: "Sam" }) },
  customer: { findUnique: vi.fn().mockResolvedValue({ name: "Jo" }) },
  property: { findUnique: vi.fn().mockResolvedValue({ addressLine: "1 High St", propertyName: null, customer: { name: "Jo" } }) },
  visit: { findUnique: vi.fn().mockResolvedValue({ property: { addressLine: "1 High St", customer: { name: "Jo" } } }) },
  ...over,
});

describe("activity labels", () => {
  it("turn ids into readable names", async () => {
    const p = db();
    expect(await roundLabel(p, "r1")).toBe('"Fri Round"');
    expect(await technicianLabel(p, "t1")).toBe("Sam");
    expect(await customerLabel(p, "c1")).toBe("Jo");
    expect(await propertyLabel(p, "p1")).toBe("Jo, 1 High St");
    expect(await visitLabel(p, "v1")).toBe("Jo, 1 High St");
  });

  it("prefer the property name over the address", async () => {
    const p = db({ property: { findUnique: vi.fn().mockResolvedValue({ addressLine: "1 High St", propertyName: "The Lodge", customer: null }) } });
    expect(await propertyLabel(p, "p1")).toBe("The Lodge");
  });

  it("fall back to a plain noun when the row is missing, blank or the lookup throws", async () => {
    const p = db({
      round: { findUnique: vi.fn().mockResolvedValue(null) },
      technician: { findUnique: vi.fn().mockResolvedValue({ name: "  " }) },
      customer: { findUnique: vi.fn().mockRejectedValue(new Error("db")) },
      property: { findUnique: vi.fn().mockResolvedValue({ addressLine: "", propertyName: null, customer: null }) },
      visit: { findUnique: vi.fn().mockResolvedValue({ property: null }) },
    });
    expect(await roundLabel(p, "r1")).toBe("a round");
    expect(await technicianLabel(p, "t1")).toBe("a technician");
    expect(await customerLabel(p, "c1")).toBe("a customer");
    expect(await propertyLabel(p, "p1")).toBe("a property");
    expect(await visitLabel(p, "v1")).toBe("a visit");
  });

  it("builds a visit label from rows already loaded", () => {
    expect(visitLabelFrom("Jo", "1 High St")).toBe("Jo, 1 High St");
    expect(visitLabelFrom(null, undefined)).toBe("a visit");
  });
});
