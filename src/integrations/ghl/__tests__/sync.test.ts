import { describe, it, expect, vi, beforeEach } from "vitest";

const getGhlToken = vi.fn();
const setGhlContactCustomFields = vi.fn().mockResolvedValue(undefined);
vi.mock("../api", () => ({
  getGhlToken: (...args: unknown[]) => getGhlToken(...args),
  setGhlContactCustomFields: (...args: unknown[]) => setGhlContactCustomFields(...args),
  createGhlContact: vi.fn(),
  updateGhlContact: vi.fn(),
  sendGhlMessage: vi.fn(),
  addGhlTags: vi.fn(),
  removeGhlTags: vi.fn(),
}));

import { queueGhlEvent, applyGhlCustomFields } from "../sync";

function makeTp() {
  return {
    integrationOutbox: { create: vi.fn().mockResolvedValue({}) },
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ ghlConnected: true }) },
    customer: { findUnique: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queueGhlEvent", () => {
  it("queues nothing when GHL is not connected (GHL is an optional add-on)", async () => {
    const tp: any = makeTp();
    tp.businessSettings.findFirst.mockResolvedValue({ ghlConnected: false });
    await queueGhlEvent(tp, "visit.completed", "cust-1");
    tp.businessSettings.findFirst.mockResolvedValue(null);
    await queueGhlEvent(tp, "visit.completed", "cust-1");
    expect(tp.integrationOutbox.create).not.toHaveBeenCalled();
  });

  it("writes an outbox row with just customerId when no extra payload is given", async () => {
    const tp: any = makeTp();
    await queueGhlEvent(tp, "visit.completed", "cust-1");
    expect(tp.integrationOutbox.create).toHaveBeenCalledWith({
      data: { eventType: "visit.completed", payload: { customerId: "cust-1" } },
    });
  });

  it("merges extra fields into the payload", async () => {
    const tp: any = makeTp();
    await queueGhlEvent(tp, "visit.completed", "cust-1", { visitId: "visit-1" });
    expect(tp.integrationOutbox.create).toHaveBeenCalledWith({
      data: { eventType: "visit.completed", payload: { customerId: "cust-1", visitId: "visit-1" } },
    });
  });
});

describe("applyGhlCustomFields", () => {
  it("does nothing when fields is empty", async () => {
    const tp: any = makeTp();
    await applyGhlCustomFields(tp, "cust-1", {});
    expect(getGhlToken).not.toHaveBeenCalled();
  });

  it("does nothing when GHL isn't connected", async () => {
    const tp: any = makeTp();
    getGhlToken.mockResolvedValue(null);
    await applyGhlCustomFields(tp, "cust-1", { balance_owed: 10 });
    expect(tp.customer.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing when the customer has no ghlContactId", async () => {
    const tp: any = makeTp();
    getGhlToken.mockResolvedValue({ accessToken: "tok", locationId: "loc-1" });
    tp.customer.findUnique.mockResolvedValue({ ghlContactId: null });
    await applyGhlCustomFields(tp, "cust-1", { balance_owed: 10 });
    expect(setGhlContactCustomFields).not.toHaveBeenCalled();
  });

  it("writes the fields to the linked GHL contact", async () => {
    const tp: any = makeTp();
    const ctx = { accessToken: "tok", locationId: "loc-1" };
    getGhlToken.mockResolvedValue(ctx);
    tp.customer.findUnique.mockResolvedValue({ ghlContactId: "ghl-1" });

    await applyGhlCustomFields(tp, "cust-1", { balance_owed: 10 });

    expect(setGhlContactCustomFields).toHaveBeenCalledWith(ctx, "ghl-1", { balance_owed: 10 });
  });
});
