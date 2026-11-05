import { describe, it, expect, vi } from "vitest";
import {
  FALLBACK_BODIES, TEMPLATE_NAMES, formatMoney, invoiceTemplateVars, loadTemplate, renderTemplate,
} from "../message-templates";

describe("renderTemplate", () => {
  it("substitutes {{var}} placeholders, tolerating inner spaces", () => {
    expect(renderTemplate("Hi {{ firstName }}, pay {{amount}}", { firstName: "Jo", amount: "£5.00" }))
      .toBe("Hi Jo, pay £5.00");
  });

  it("renders unknown {{vars}} as empty, never as the literal placeholder", () => {
    expect(renderTemplate("A{{nope}}B", {})).toBe("AB");
  });

  it("substitutes the seeded [Label] form for known variables only", () => {
    expect(renderTemplate("Hi [Customer Name], see [Unknown Thing]", { customerName: "Jo Bloggs" }))
      .toBe("Hi Jo Bloggs, see [Unknown Thing]");
  });
});

describe("loadTemplate", () => {
  it("returns the tenant template when one matches by name (case-insensitive)", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "t1", body: "custom" });
    const tp = { messageTemplate: { findFirst } } as never;
    await expect(loadTemplate(tp, TEMPLATE_NAMES.INVOICE, "fallback")).resolves.toEqual({ id: "t1", body: "custom" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { name: { equals: "Invoice Ready", mode: "insensitive" } },
      select: { id: true, body: true },
    });
  });

  it("falls back to the built-in body when the tenant has no such template", async () => {
    const tp = { messageTemplate: { findFirst: vi.fn().mockResolvedValue(null) } } as never;
    await expect(loadTemplate(tp, "x", FALLBACK_BODIES.PAYMENT_LINK))
      .resolves.toEqual({ id: null, body: FALLBACK_BODIES.PAYMENT_LINK });
  });
});

describe("formatMoney / invoiceTemplateVars", () => {
  it("defaults the currency symbol to £", () => {
    expect(formatMoney(3, null)).toBe("£3.00");
    expect(formatMoney(3, "€")).toBe("€3.00");
  });

  it("builds the full variable set", () => {
    expect(invoiceTemplateVars({
      customerName: "Jo Bloggs", invoiceNumber: "INV-1", amount: 12.5,
      dueDate: new Date("2026-11-06T00:00:00Z"), currency: "£", businessName: "Coates", paymentLink: "https://x",
    })).toEqual({
      customerName: "Jo Bloggs", firstName: "Jo", invoiceNumber: "INV-1", amount: "£12.50",
      dueDate: "2026-11-06", businessName: "Coates", paymentLink: "https://x",
    });
  });

  it("renders missing optional values as empty strings", () => {
    expect(invoiceTemplateVars({ customerName: "Jo", invoiceNumber: "INV-1", amount: 1, dueDate: null }))
      .toMatchObject({ dueDate: "", businessName: "", paymentLink: "" });
  });
});
