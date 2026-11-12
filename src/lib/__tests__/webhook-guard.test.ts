import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response } from "express";
import { guardWebhook } from "../webhook-guard";

function makeRes(headersSent = false) {
  const res = {
    headersSent,
    set: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

const req = {} as Request;

afterEach(() => vi.restoreAllMocks());

describe("guardWebhook", () => {
  it("passes through when the handler resolves", async () => {
    const res = makeRes();
    const handler = vi.fn().mockResolvedValue(undefined);
    guardWebhook("t", handler)(req, res);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(req, res));
    expect(res.status).not.toHaveBeenCalled();
  });

  it("logs and answers 500 when the handler throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    guardWebhook("t", () => Promise.reject(new Error("boom")))(req, res);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(500));
    expect(res.json).toHaveBeenCalledWith({ error: "Internal Server Error" });
    expect(spy).toHaveBeenCalledWith("[t] handler failed:", expect.any(Error));
  });

  it("answers 503 with Retry-After when the database is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    const dbErr = Object.assign(new Error("down"), { name: "PrismaClientInitializationError" });
    guardWebhook("t", () => Promise.reject(dbErr))(req, res);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(503));
    expect(res.set).toHaveBeenCalledWith("Retry-After", "5");
  });

  it("only logs when the response was already sent", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes(true);
    guardWebhook("t", () => Promise.reject(new Error("late")))(req, res);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(res.status).not.toHaveBeenCalled();
  });
});
