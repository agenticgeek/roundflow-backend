import { describe, it, expect, vi } from "vitest";
import { createMandateSetupLink, getFulfilledMandate, listCollectableMandates, RF_CUSTOMER_KEY } from "../mandate";
import type { GcClient } from "../client";

async function* gen<T>(items: T[]) {
  for (const i of items) yield i;
}

describe("createMandateSetupLink", () => {
  it("creates a Bacs mandate request tagged with the customer, then a prefilled hosted flow", async () => {
    const client = {
      billingRequests: { create: vi.fn().mockResolvedValue({ id: "BRQ1" }) },
      billingRequestFlows: {
        create: vi.fn().mockResolvedValue({ id: "BRF1", authorisation_url: "https://pay.gocardless.com/BRF1", expires_at: "2026-11-26T10:00:00Z" }),
      },
    } as unknown as GcClient;

    const link = await createMandateSetupLink(client, { id: "c1", name: "Amelia Jane Jones", email: "a@x.com" }, "Direct Debit for Shine");

    expect(client.billingRequests.create).toHaveBeenCalledWith({
      mandate_request: { scheme: "bacs", description: "Direct Debit for Shine" },
      metadata: { [RF_CUSTOMER_KEY]: "c1" },
    });
    expect(client.billingRequestFlows.create).toHaveBeenCalledWith({
      links: { billing_request: "BRQ1" },
      prefilled_customer: { given_name: "Amelia", family_name: "Jane Jones", email: "a@x.com" },
    });
    expect(link).toEqual({ billingRequestId: "BRQ1", url: "https://pay.gocardless.com/BRF1", expiresAt: new Date("2026-11-26T10:00:00Z") });
  });

  it("handles a one-word name, no email and no expiry", async () => {
    const client = {
      billingRequests: { create: vi.fn().mockResolvedValue({ id: "BRQ2" }) },
      billingRequestFlows: { create: vi.fn().mockResolvedValue({ id: "BRF2", authorisation_url: "https://x" }) },
    } as unknown as GcClient;
    const link = await createMandateSetupLink(client, { id: "c2", name: "Cher", email: null }, "d");
    expect(client.billingRequestFlows.create).toHaveBeenCalledWith({
      links: { billing_request: "BRQ2" },
      prefilled_customer: { given_name: "Cher", family_name: "" },
    });
    expect(link.expiresAt).toBeNull();
  });

  it("throws when GoCardless returns no authorisation url", async () => {
    const client = {
      billingRequests: { create: vi.fn().mockResolvedValue({ id: "BRQ3" }) },
      billingRequestFlows: { create: vi.fn().mockResolvedValue({ id: "BRF3" }) },
    } as unknown as GcClient;
    await expect(createMandateSetupLink(client, { id: "c3", name: "A B", email: null }, "d")).rejects.toThrow("no authorisation url");
  });
});

describe("getFulfilledMandate", () => {
  it("returns the mandate, GoCardless customer, RoundFlow customer and mandate status", async () => {
    const client = {
      billingRequests: {
        find: vi.fn().mockResolvedValue({ id: "BRQ1", links: { mandate_request_mandate: "MD1", customer: "CU1" }, metadata: { [RF_CUSTOMER_KEY]: "c1" } }),
      },
      mandates: { find: vi.fn().mockResolvedValue({ id: "MD1", status: "pending_submission", links: { customer: "CU1" } }) },
    } as unknown as GcClient;
    await expect(getFulfilledMandate(client, "BRQ1")).resolves.toEqual({
      mandateId: "MD1",
      gcCustomerId: "CU1",
      rfCustomerId: "c1",
      status: "pending_submission",
    });
  });

  it("falls back to the mandate's customer link, a default status, and no RoundFlow id", async () => {
    const client = {
      billingRequests: { find: vi.fn().mockResolvedValue({ id: "BRQ1", links: { mandate_request_mandate: "MD1" } }) },
      mandates: { find: vi.fn().mockResolvedValue({ id: "MD1", links: { customer: "CU9" } }) },
    } as unknown as GcClient;
    await expect(getFulfilledMandate(client, "BRQ1")).resolves.toEqual({
      mandateId: "MD1",
      gcCustomerId: "CU9",
      rfCustomerId: null,
      status: "pending_submission",
    });
    const noLinks = {
      billingRequests: { find: vi.fn().mockResolvedValue({ id: "BRQ1", links: { mandate_request_mandate: "MD1" } }) },
      mandates: { find: vi.fn().mockResolvedValue({ id: "MD1" }) },
    } as unknown as GcClient;
    await expect(getFulfilledMandate(noLinks, "BRQ1")).resolves.toMatchObject({ gcCustomerId: null });
  });

  it("returns null when the request produced no mandate", async () => {
    const client = { billingRequests: { find: vi.fn().mockResolvedValue({ id: "BRQ1", links: {} }) } } as unknown as GcClient;
    await expect(getFulfilledMandate(client, "BRQ1")).resolves.toBeNull();
    const noLinks = { billingRequests: { find: vi.fn().mockResolvedValue({ id: "BRQ1" }) } } as unknown as GcClient;
    await expect(getFulfilledMandate(noLinks, "BRQ1")).resolves.toBeNull();
  });
});

describe("listCollectableMandates", () => {
  it("joins collectable mandates to their customers' details", async () => {
    const client = {
      customers: {
        all: vi.fn(() =>
          gen([
            { id: "CU1", given_name: "Oliver", family_name: "Smith", email: "o@x.com", phone_number: "+447700900001", postal_code: "NE1 1AA" },
            { id: "CU2", company_name: "Acme Ltd", email: " ", given_name: "" },
            { given_name: "no id" },
          ]),
        ),
      },
      mandates: {
        all: vi.fn(() =>
          gen([
            { id: "MD1", status: "active", reference: "REF1", created_at: "2026-01-01", links: { customer: "CU1" } },
            { id: "MD2", links: { customer: "CU2" } },
            { id: "MD3", links: { customer: "CU404" } },
            { id: "MD4" },
          ]),
        ),
      },
    } as unknown as GcClient;

    const rows = await listCollectableMandates(client);
    expect(client.mandates.all).toHaveBeenCalledWith({ status: ["active", "pending_submission", "submitted"], limit: 500 });
    expect(rows).toEqual([
      { mandateId: "MD1", status: "active", reference: "REF1", createdAt: "2026-01-01", gcCustomerId: "CU1", name: "Oliver Smith", email: "o@x.com", phone: "+447700900001", postcode: "NE1 1AA" },
      { mandateId: "MD2", status: "active", reference: null, createdAt: null, gcCustomerId: "CU2", name: "Acme Ltd", email: null, phone: null, postcode: null },
      { mandateId: "MD3", status: "active", reference: null, createdAt: null, gcCustomerId: "CU404", name: "(no name)", email: null, phone: null, postcode: null },
    ]);
  });
});
