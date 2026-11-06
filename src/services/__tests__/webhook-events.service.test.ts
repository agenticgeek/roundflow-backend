import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../generated/tenant-client";
import {
  WEBHOOK_MAX_ATTEMPTS,
  backoffMs,
  processWebhookEvent,
  recordWebhookEvent,
  sweepWebhookEvents,
} from "../webhook-events.service";

const p2002 = () => new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });

function tpMock() {
  return {
    webhookEvent: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordWebhookEvent", () => {
  it("inserts a RECEIVED row with the payload and says 'new'", async () => {
    const tp = tpMock();
    await expect(recordWebhookEvent(tp as never, "stripe", "evt_1", { a: 1 })).resolves.toBe("new");
    expect(tp.webhookEvent.create).toHaveBeenCalledWith({
      data: { source: "stripe", externalId: "evt_1", status: "RECEIVED", payload: { a: 1 } },
    });
  });

  it("a duplicate whose row is DONE (or vanished) is 'duplicate'; one that is FAILED/RECEIVED is 'retry'", async () => {
    const tp = tpMock();
    tp.webhookEvent.create.mockRejectedValue(p2002());
    tp.webhookEvent.findUnique.mockResolvedValueOnce({ status: "DONE" });
    await expect(recordWebhookEvent(tp as never, "stripe", "e", {})).resolves.toBe("duplicate");
    tp.webhookEvent.findUnique.mockResolvedValueOnce(null);
    await expect(recordWebhookEvent(tp as never, "stripe", "e", {})).resolves.toBe("duplicate");
    tp.webhookEvent.findUnique.mockResolvedValueOnce({ status: "FAILED" });
    await expect(recordWebhookEvent(tp as never, "stripe", "e", {})).resolves.toBe("retry");
    expect(tp.webhookEvent.findUnique).toHaveBeenCalledWith({ where: { source_externalId: { source: "stripe", externalId: "e" } }, select: { status: true } });
  });

  it("any other database error is rethrown (nothing recorded -> the provider must retry)", async () => {
    const tp = tpMock();
    tp.webhookEvent.create.mockRejectedValue(new Error("db down"));
    await expect(recordWebhookEvent(tp as never, "ghl", "e", {})).rejects.toThrow("db down");
  });
});

describe("processWebhookEvent", () => {
  it("records, runs the handler, marks DONE and drops the stored payload", async () => {
    const tp = tpMock();
    const handler = vi.fn().mockResolvedValue(undefined);
    await expect(processWebhookEvent(tp as never, "stripe", "evt_1", { a: 1 }, handler)).resolves.toBe("done");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(tp.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { source: "stripe", externalId: "evt_1" },
      data: { status: "DONE", lastError: null, payload: Prisma.DbNull },
    });
  });

  it("skips a duplicate without running the handler", async () => {
    const tp = tpMock();
    tp.webhookEvent.create.mockRejectedValue(p2002());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "DONE" });
    const handler = vi.fn();
    await expect(processWebhookEvent(tp as never, "stripe", "e", {}, handler)).resolves.toBe("duplicate");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a failing handler leaves the event FAILED and retryable, then a redelivery reconciles it (replay after failure)", async () => {
    const tp = tpMock();
    const handler = vi.fn().mockRejectedValueOnce(new Error("effect failed")).mockResolvedValueOnce(undefined);

    await expect(processWebhookEvent(tp as never, "stripe", "evt_9", { a: 1 }, handler)).resolves.toBe("failed");
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith({
      where: { source: "stripe", externalId: "evt_9" },
      data: { status: "FAILED", lastError: "Error: effect failed", attempts: { increment: 1 } },
    });

    // The provider redelivers the same event: the row exists and is not DONE, so it is processed again.
    tp.webhookEvent.create.mockRejectedValue(p2002());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "FAILED" });
    await expect(processWebhookEvent(tp as never, "stripe", "evt_9", { a: 1 }, handler)).resolves.toBe("done");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(tp.webhookEvent.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DONE" }) }));
  });

  it("truncates a very long error message", async () => {
    const tp = tpMock();
    await processWebhookEvent(tp as never, "ghl", "e", {}, async () => {
      throw new Error("x".repeat(1000));
    });
    const data = tp.webhookEvent.updateMany.mock.calls[0][0].data;
    expect(data.lastError.length).toBe(500);
  });

  it("logs an event that exhausted its attempts", async () => {
    const tp = tpMock();
    await processWebhookEvent(tp as never, "ghl", "e", {}, async () => {
      throw new Error("x");
    }, { priorAttempts: WEBHOOK_MAX_ATTEMPTS - 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("giving up"), expect.any(Error));
  });
});

describe("backoffMs", () => {
  it("grows with the number of attempts and is capped", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(1)).toBe(300_000);
    expect(backoffMs(2)).toBe(1_800_000);
    expect(backoffMs(3)).toBe(7_200_000);
    expect(backoffMs(4)).toBe(21_600_000);
    expect(backoffMs(99)).toBe(21_600_000);
  });
});

describe("sweepWebhookEvents (retry sweep)", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const row = (over: Record<string, unknown>) => ({
    source: "stripe",
    externalId: "e1",
    status: "FAILED",
    attempts: 1,
    payload: { n: 1 },
    updatedAt: new Date(now.getTime() - 10 * 60_000),
    ...over,
  });

  it("selects FAILED and stale RECEIVED rows that still have attempts left", async () => {
    const tp = tpMock();
    await sweepWebhookEvents(tp as never, {}, now);
    expect(tp.webhookEvent.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["FAILED", "RECEIVED"] },
        attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
        updatedAt: { lt: new Date(now.getTime() - 60_000) },
      },
      orderBy: { updatedAt: "asc" },
      take: 50,
    });
  });

  it("re-processes due rows through the handler for their source and counts outcomes", async () => {
    const tp = tpMock();
    const stripe = vi.fn().mockResolvedValue(undefined);
    const ghl = vi.fn().mockRejectedValue(new Error("still broken"));
    tp.webhookEvent.findMany.mockResolvedValue([
      row({}),
      row({ source: "ghl", externalId: "g1" }),
      row({ externalId: "waiting", attempts: 3, updatedAt: new Date(now.getTime() - 60_000) }), // backoff not elapsed
    ]);
    tp.webhookEvent.create.mockRejectedValue(p2002());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "FAILED" });

    const res = await sweepWebhookEvents(tp as never, { stripe, ghl }, now);

    expect(stripe).toHaveBeenCalledWith({ n: 1 });
    expect(ghl).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ retried: 2, done: 1, failed: 1, skipped: 1 });
  });

  it("a retried row that another worker already finished counts as neither done nor failed", async () => {
    const tp = tpMock();
    tp.webhookEvent.findMany.mockResolvedValue([row({})]);
    tp.webhookEvent.create.mockRejectedValue(p2002());
    tp.webhookEvent.findUnique.mockResolvedValue({ status: "DONE" });
    const handler = vi.fn();
    const res = await sweepWebhookEvents(tp as never, { stripe: handler }, now);
    expect(handler).not.toHaveBeenCalled();
    expect(res).toEqual({ retried: 1, done: 0, failed: 0, skipped: 0 });
  });

  it("a row with no stored payload or no handler cannot be retried: it is parked as dead", async () => {
    const tp = tpMock();
    tp.webhookEvent.findMany.mockResolvedValue([row({ payload: null }), row({ source: "unknown", externalId: "u" })]);
    const res = await sweepWebhookEvents(tp as never, { stripe: vi.fn() }, now);
    expect(res).toEqual({ retried: 0, done: 0, failed: 0, skipped: 2 });
    expect(tp.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: { source: "stripe", externalId: "e1" },
      data: { status: "FAILED", attempts: WEBHOOK_MAX_ATTEMPTS, lastError: "No stored payload or handler: cannot be retried" },
    });
  });
});
