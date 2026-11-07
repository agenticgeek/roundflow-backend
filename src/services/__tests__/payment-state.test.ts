import { describe, expect, it } from "vitest";
import { PaymentStatus as S } from "../../generated/tenant-client";
import { ALLOWED_TRANSITIONS, COLLECTING_STATUSES, MANUALLY_SETTLEABLE, canTransition } from "../payment-state";
import { NOT_COLLECTING_INVOICE } from "../direct-debit";

describe("payment state machine (BE-07)", () => {
  it("PENDING can become PAID, FAILED or CANCELLED", () => {
    for (const to of [S.PAID, S.FAILED, S.CANCELLED, S.PROCESSING]) expect(canTransition(S.PENDING, to)).toBe(true);
  });

  it("FAILED can recover to PAID on retry, but never to PENDING/CANCELLED", () => {
    expect(canTransition(S.FAILED, S.PAID)).toBe(true);
    expect(canTransition(S.FAILED, S.PROCESSING)).toBe(true);
    expect(canTransition(S.FAILED, S.CANCELLED)).toBe(false);
    expect(canTransition(S.FAILED, S.PENDING)).toBe(false);
  });

  it("PAID is terminal except REFUNDED and DISPUTED: a late FAILED/CANCELLED/PROCESSING never overwrites it", () => {
    expect(ALLOWED_TRANSITIONS[S.PAID]).toEqual([S.REFUNDED, S.DISPUTED]);
    for (const to of [S.FAILED, S.CANCELLED, S.PROCESSING, S.PENDING, S.OVERDUE]) expect(canTransition(S.PAID, to)).toBe(false);
  });

  it("DISPUTED resolves to PAID (won) or REFUNDED; CANCELLED and REFUNDED are terminal", () => {
    expect(canTransition(S.DISPUTED, S.PAID)).toBe(true);
    expect(canTransition(S.DISPUTED, S.REFUNDED)).toBe(true);
    expect(ALLOWED_TRANSITIONS[S.CANCELLED]).toEqual([]);
    expect(ALLOWED_TRANSITIONS[S.REFUNDED]).toEqual([]);
  });

  it("PROCESSING (direct debit collecting) ends in PAID, FAILED or CANCELLED; OVERDUE can still be settled", () => {
    for (const to of [S.PAID, S.FAILED, S.CANCELLED]) expect(canTransition(S.PROCESSING, to)).toBe(true);
    expect(canTransition(S.PROCESSING, S.PENDING)).toBe(false);
    expect(canTransition(S.OVERDUE, S.PAID)).toBe(true);
    expect(canTransition(S.NOT_DUE, S.OVERDUE)).toBe(true);
  });

  it("every status has a transition entry", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(Object.values(S).sort());
  });
});

describe("direct debit exclusion fragment (ACT-07)", () => {
  it("excludes invoices whose GoCardless payment is PENDING or PROCESSING", () => {
    expect([...COLLECTING_STATUSES]).toEqual([S.PENDING, S.PROCESSING]);
    expect(NOT_COLLECTING_INVOICE).toEqual({
      NOT: { visit: { is: { payment: { is: { method: "GOCARDLESS", status: { in: ["PENDING", "PROCESSING"] } } } } } },
    });
  });
});

describe("MANUALLY_SETTLEABLE", () => {
  it("lets a person settle open or dead payments but never DISPUTED / REFUNDED / already PAID", () => {
    expect([...MANUALLY_SETTLEABLE].sort()).toEqual([S.NOT_DUE, S.PENDING, S.OVERDUE, S.PROCESSING, S.FAILED, S.CANCELLED].sort());
    for (const blocked of [S.DISPUTED, S.REFUNDED, S.PAID]) expect(MANUALLY_SETTLEABLE).not.toContain(blocked);
  });
});
