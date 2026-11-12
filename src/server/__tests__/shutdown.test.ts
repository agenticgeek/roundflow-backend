import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown } from "../shutdown";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(over: { close?: (cb: (err?: Error) => void) => void; disconnect?: () => Promise<unknown>; waitForJobs?: () => Promise<unknown> } = {}) {
  const handlers: Record<string, (s: string) => void> = {};
  const order: string[] = [];
  const server = {
    close: vi.fn(over.close ?? ((cb: (err?: Error) => void) => { order.push("close"); cb(); })),
    closeIdleConnections: vi.fn(),
  };
  const deps = {
    server,
    stopJobs: vi.fn(() => order.push("stopJobs")),
    waitForJobs: vi.fn(over.waitForJobs ?? (async () => { order.push("drain"); })),
    disconnect: vi.fn(over.disconnect ?? (async () => { order.push("disconnect"); })),
    exit: vi.fn(),
    proc: { on: (ev: string, fn: (s: string) => void) => { handlers[ev] = fn; } },
    timeoutMs: 1000,
  };
  const shutdown = installGracefulShutdown(deps);
  return { deps, handlers, order, shutdown, server };
}

describe("installGracefulShutdown (BE-09)", () => {
  it("registers SIGTERM and SIGINT", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("stops accepting, stops crons, drains jobs, disconnects, then exits 0", async () => {
    const { deps, order, shutdown, server } = setup();
    await shutdown("SIGTERM");
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(order[0]).toBe("stopJobs");
    expect(order).toEqual(expect.arrayContaining(["close", "drain", "disconnect"]));
    expect(order.indexOf("disconnect")).toBeGreaterThan(order.indexOf("drain"));
    expect(order.indexOf("disconnect")).toBeGreaterThan(order.indexOf("close"));
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("works through the signal handlers and runs only once", async () => {
    const { deps, handlers, server } = setup();
    handlers.SIGINT("SIGINT");
    handlers.SIGTERM("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the server fails to close, and when disconnect throws", async () => {
    const a = setup({ close: (cb) => cb(new Error("not running")) });
    await a.shutdown("SIGTERM");
    expect(a.deps.exit).toHaveBeenCalledWith(1);
    const b = setup({ disconnect: async () => { throw new Error("pool"); } });
    await b.shutdown("SIGTERM");
    expect(b.deps.exit).toHaveBeenCalledWith(1);
  });

  it("forces exit 1 after the hard timeout when drain hangs, and does not exit twice", async () => {
    let release: (err?: Error) => void = () => {};
    const { deps, shutdown } = setup({ close: (cb) => { release = cb; } });
    const pending = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(deps.exit).toHaveBeenCalledWith(1);
    release(); // the late drain finishing must not exit a second time
    await pending;
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it("uses a 25 s default timeout and the real process when not injected", async () => {
    const on = vi.spyOn(process, "on").mockImplementation((() => process) as never);
    const exit = vi.fn();
    const shutdown = installGracefulShutdown({
      server: { close: () => {} },
      stopJobs: () => {},
      waitForJobs: async () => {},
      disconnect: async () => {},
      exit,
    });
    void shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });
});
