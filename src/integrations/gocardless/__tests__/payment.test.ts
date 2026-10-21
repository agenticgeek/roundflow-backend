import { describe, it, expect, vi } from "vitest";
import { createGcPayment } from "../payment";
import type { GcClient } from "../client";

describe("createGcPayment", () => {
  it("creates a payment against the given mandate and returns its id and status", async () => {
    const client = {
      payments: {
        create: vi.fn().mockResolvedValue({ id: "PM123", status: "pending_submission" }),
      },
    } as unknown as GcClient;

    const result = await createGcPayment(client, {
      mandateId: "MD123",
      amountPence: 3500,
      description: "Window cleaning — visit visit-1",
      reference: "VISIT123",
      metadata: { visitId: "visit-1", customerId: "cust-1" },
    });

    expect(client.payments.create).toHaveBeenCalledWith({
      amount: 3500,
      currency: "GBP",
      description: "Window cleaning — visit visit-1",
      reference: "VISIT123",
      links: { mandate: "MD123" },
      metadata: { visitId: "visit-1", customerId: "cust-1" },
    });
    expect(result).toEqual({ id: "PM123", status: "pending_submission" });
  });

  it("works without metadata (optional)", async () => {
    const client = {
      payments: {
        create: vi.fn().mockResolvedValue({ id: "PM124", status: "pending_submission" }),
      },
    } as unknown as GcClient;

    await createGcPayment(client, {
      mandateId: "MD123",
      amountPence: 1000,
      description: "Window cleaning",
      reference: "VISIT124",
    });

    expect(client.payments.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: undefined })
    );
  });
});
