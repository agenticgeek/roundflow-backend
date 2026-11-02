import { it, expect } from "vitest";
import {
  optPreCleanReminders,
  remindersFromLegacy,
  legacyFromReminders,
  parseStoredReminders,
  resolveReminderInput,
  optPaymentMethods,
  resolvePaymentMethods,
} from "../settings-validators";

const bad = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ statusCode: 400 }));

it("BUG-01 optPreCleanReminders validates the { type, time } list and defaults times", () => {
  expect(optPreCleanReminders(undefined)).toBeUndefined();
  expect(optPreCleanReminders([])).toEqual([]);
  expect(optPreCleanReminders([{ type: "EVENING_BEFORE" }, { type: "MORNING_OF", time: "06:30" }])).toEqual([
    { type: "EVENING_BEFORE", time: "19:00" },
    { type: "MORNING_OF", time: "06:30" },
  ]);
  bad(() => optPreCleanReminders("x"));
  bad(() => optPreCleanReminders([1]));
  bad(() => optPreCleanReminders([{ type: "NONE" }]));
  bad(() => optPreCleanReminders([{ type: "MORNING_OF", time: "7am" }]));
  bad(() => optPreCleanReminders([{ type: "MORNING_OF" }, { type: "MORNING_OF" }]));
  bad(() => optPreCleanReminders([{ type: "MORNING_OF" }, { type: "EVENING_BEFORE" }, { type: "MORNING_OF" }]));
});

it("BUG-01 legacy conversion round-trips and stored rows are read tolerantly", () => {
  expect(remindersFromLegacy("NONE")).toEqual([]);
  expect(remindersFromLegacy("MORNING_OF")).toEqual([{ type: "MORNING_OF", time: "07:00" }]);
  expect(remindersFromLegacy("EVENING_BEFORE", "18:00")).toEqual([{ type: "EVENING_BEFORE", time: "18:00" }]);
  expect(legacyFromReminders([])).toEqual({ reminderMode: "NONE", reminderTime: "19:00" });
  expect(legacyFromReminders([{ type: "MORNING_OF", time: "07:30" }])).toEqual({
    reminderMode: "MORNING_OF",
    reminderTime: "07:30",
  });

  expect(
    parseStoredReminders([{ type: "MORNING_OF", time: "bad" }, { type: "MORNING_OF", time: "08:00" }, { type: "X" }, null])
  ).toEqual([{ type: "MORNING_OF", time: "07:00" }]);
  expect(parseStoredReminders(null, "MORNING_OF", "06:00")).toEqual([{ type: "MORNING_OF", time: "06:00" }]);
  expect(parseStoredReminders(undefined)).toEqual([{ type: "EVENING_BEFORE", time: "19:00" }]);
});

it("BUG-01 resolveReminderInput prefers the list, then legacy mode, then a bare time", () => {
  const current = [
    { type: "EVENING_BEFORE" as const, time: "19:00" },
    { type: "MORNING_OF" as const, time: "07:00" },
  ];
  expect(resolveReminderInput({ preCleanReminders: [], reminderMode: "MORNING_OF" }, current)).toEqual([]);
  expect(resolveReminderInput({ reminderMode: "MORNING_OF", reminderTime: "06:00" }, current)).toEqual([
    { type: "MORNING_OF", time: "06:00" },
  ]);
  expect(resolveReminderInput({ reminderTime: "18:00" }, current)).toEqual([
    { type: "EVENING_BEFORE", time: "18:00" },
    current[1],
  ]);
  expect(resolveReminderInput({}, current)).toBeUndefined();
});

it("BUG-05 payment methods: list validation, default must be accepted, default seeds an empty list", () => {
  expect(optPaymentMethods(undefined)).toBeUndefined();
  expect(optPaymentMethods(["STRIPE", "CASH", "STRIPE"])).toEqual(["STRIPE", "CASH"]);
  bad(() => optPaymentMethods("CASH"));
  bad(() => optPaymentMethods(["PAYPAL"]));

  expect(resolvePaymentMethods({}, null)).toEqual({});
  // no provider connection needed to accept GOCARDLESS / STRIPE
  expect(
    resolvePaymentMethods({ acceptedPaymentMethods: ["GOCARDLESS", "STRIPE"], defaultPaymentMethod: "STRIPE" }, null)
  ).toEqual({ acceptedPaymentMethods: ["GOCARDLESS", "STRIPE"], defaultPaymentMethod: "STRIPE" });
  expect(
    resolvePaymentMethods({ defaultPaymentMethod: "CASH" }, { acceptedPaymentMethods: [], defaultPaymentMethod: null })
  ).toEqual({ acceptedPaymentMethods: ["CASH"], defaultPaymentMethod: "CASH" });
  expect(resolvePaymentMethods({ defaultPaymentMethod: "CASH" }, { acceptedPaymentMethods: ["CASH", "BACS"] })).toEqual({
    acceptedPaymentMethods: undefined,
    defaultPaymentMethod: "CASH",
  });
  bad(() => resolvePaymentMethods({ defaultPaymentMethod: "CHEQUE" }, { acceptedPaymentMethods: ["CASH"] }));
  bad(() =>
    resolvePaymentMethods(
      { acceptedPaymentMethods: ["BACS"] },
      { acceptedPaymentMethods: ["CASH", "BACS"], defaultPaymentMethod: "CASH" }
    )
  );
  expect(
    resolvePaymentMethods({ defaultPaymentMethod: null }, { acceptedPaymentMethods: ["CASH"], defaultPaymentMethod: "CASH" })
  ).toEqual({ acceptedPaymentMethods: undefined, defaultPaymentMethod: null });
});

it("BUG-05 resolvePaymentMethods tolerates missing current settings and a null accepted list", () => {
  expect(resolvePaymentMethods({ defaultPaymentMethod: "CASH" }, null)).toEqual({ acceptedPaymentMethods: ["CASH"], defaultPaymentMethod: "CASH" });
  expect(resolvePaymentMethods({ defaultPaymentMethod: "CASH" }, { acceptedPaymentMethods: null })).toEqual({ acceptedPaymentMethods: ["CASH"], defaultPaymentMethod: "CASH" });
  expect(resolvePaymentMethods({ acceptedPaymentMethods: ["BACS"] }, null)).toEqual({ acceptedPaymentMethods: ["BACS"], defaultPaymentMethod: undefined });
});
