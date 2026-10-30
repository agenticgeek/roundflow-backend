import { it, expect } from "vitest";
import {
  optReminderMode,
  optCleanMethod,
  optPaymentMethod,
  optNoDirectDebitAction,
  optReminderTime,
  optVatRate,
  optInvoiceDueDays,
  rejectRemovedFields,
  reminderModeFromLegacy,
  foldServiceAreaIds,
} from "../settings-validators";

const bad = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ statusCode: 400 }));

it("enum validators: undefined untouched, valid passes, null only where nullable", () => {
  expect(optReminderMode(undefined)).toBeUndefined();
  expect(optReminderMode("MORNING_OF")).toBe("MORNING_OF");
  bad(() => optReminderMode(null));
  bad(() => optReminderMode("LUNCHTIME"));

  expect(optCleanMethod(null)).toBeNull();
  expect(optCleanMethod("WATER_FED_POLE")).toBe("WATER_FED_POLE");
  bad(() => optCleanMethod(3));

  expect(optPaymentMethod("BACS", "defaultPaymentMethod")).toBe("BACS");
  expect(optPaymentMethod(null, "defaultPaymentMethod")).toBeNull();
  bad(() => optPaymentMethod("PAYPAL", "defaultPaymentMethod"));

  expect(optNoDirectDebitAction("SEND_PAYMENT_LINK")).toBe("SEND_PAYMENT_LINK");
  expect(optNoDirectDebitAction(undefined)).toBeUndefined();
  bad(() => optNoDirectDebitAction("CALL_THEM"));
});

it("optReminderTime accepts 24h HH:mm only", () => {
  expect(optReminderTime(undefined)).toBeUndefined();
  expect(optReminderTime("19:00")).toBe("19:00");
  expect(optReminderTime("00:05")).toBe("00:05");
  for (const v of ["24:00", "7:00", "19:60", "19:00:00", 1900, null]) bad(() => optReminderTime(v));
});

it("optVatRate accepts 0–100, rounded to 2dp", () => {
  expect(optVatRate(undefined)).toBeUndefined();
  expect(optVatRate(0)).toBe(0);
  expect(optVatRate(100)).toBe(100);
  expect(optVatRate(17.555)).toBe(17.56);
  for (const v of [-1, 100.01, "20", Number.NaN, null]) bad(() => optVatRate(v));
});

it("optInvoiceDueDays accepts integers 1–90", () => {
  expect(optInvoiceDueDays(undefined)).toBeUndefined();
  expect(optInvoiceDueDays(1)).toBe(1);
  expect(optInvoiceDueDays(90)).toBe(90);
  for (const v of [0, 91, 7.5, "7"]) bad(() => optInvoiceDueDays(v));
});

it("rejectRemovedFields 400s with code FIELD_REMOVED when any removed field is present", () => {
  expect(() => rejectRemovedFields({ paymentRule: "X" }, ["stripeConnected"])).not.toThrow();
  expect(() => rejectRemovedFields({ stripeConnected: false, gocardlessConnected: true }, ["gocardlessConnected", "stripeConnected"]))
    .toThrow(expect.objectContaining({ statusCode: 400, code: "FIELD_REMOVED", message: expect.stringContaining("gocardlessConnected, stripeConnected") }));
});

it("reminderModeFromLegacy maps the deprecated timings", () => {
  expect(reminderModeFromLegacy(["TWO_HOURS_BEFORE", "EVENING_BEFORE"])).toBe("EVENING_BEFORE");
  expect(reminderModeFromLegacy(["TWO_HOURS_BEFORE"])).toBe("MORNING_OF");
  expect(reminderModeFromLegacy([])).toBe("NONE");
});

it("foldServiceAreaIds folds a singular serviceAreaId into serviceAreaIds", () => {
  expect(foldServiceAreaIds({})).toBeUndefined();
  expect(foldServiceAreaIds({ serviceAreaIds: ["a"] })).toEqual(["a"]);
  expect(foldServiceAreaIds({ serviceAreaId: "b" })).toEqual(["b"]);
  expect(foldServiceAreaIds({ serviceAreaIds: ["a", "b"], serviceAreaId: "b" })).toEqual(["a", "b"]);
  expect(foldServiceAreaIds({ serviceAreaId: "" })).toBeUndefined();
  bad(() => foldServiceAreaIds({ serviceAreaId: 5 }, "technicians[0]."));
});
