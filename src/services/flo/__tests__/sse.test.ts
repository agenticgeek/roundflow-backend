import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloEvent } from "../answer";
import { frame, HEARTBEAT_MS, SSE_HEADERS, streamEvents } from "../sse";

class FakeRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  flushed = false;
  writableEnded = false;
  destroyed = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  set(h: Record<string, string>) {
    Object.assign(this.headers, h);
    return this;
  }
  flushHeaders() {
    this.flushed = true;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit("close");
  }
  get body() {
    return this.chunks.join("");
  }
}

const asRes = (r: FakeRes) => r as unknown as Parameters<typeof streamEvents>[0];
const ev = (event: FloEvent["event"], data: unknown) => ({ event, data }) as FloEvent;

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("frame", () => {
  it("is `event:` plus one JSON data line and a blank line", () => {
    expect(frame("text", { a: 1, b: "x\ny" })).toBe('event: text\ndata: {"a":1,"b":"x\\ny"}\n\n');
  });
});

describe("streamEvents", () => {
  it("sets the streaming headers (no-transform, X-Accel-Buffering: no), flushes, then writes events in order", async () => {
    const res = new FakeRes();
    await streamEvents(asRes(res), async function* () {
      yield ev("start", { conversationId: "c", messageId: "m", mode: "BALANCED" });
      yield ev("text", { target: "intro", index: 0, text: "Hi." });
      yield ev("done", { message: { id: "m" } });
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual(SSE_HEADERS);
    expect(res.headers["Cache-Control"]).toBe("no-cache, no-transform");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.headers.Connection).toBe("keep-alive");
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    expect(res.flushed).toBe(true);
    expect(res.body).toBe(
      ': ping\n\n' + frame("start", { conversationId: "c", messageId: "m", mode: "BALANCED" }) + frame("text", { target: "intro", index: 0, text: "Hi." }) + frame("done", { message: { id: "m" } })
    );
    expect(res.writableEnded).toBe(true);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("merges extra headers", async () => {
    const res = new FakeRes();
    await streamEvents(asRes(res), async function* () {}, { headers: { "Idempotent-Replay": "true" } });
    expect(res.headers["Idempotent-Replay"]).toBe("true");
    expect(res.headers["Cache-Control"]).toBe("no-cache, no-transform");
  });

  it("sends a `: ping` comment every 15 s while the source is quiet, and stops after the end", async () => {
    vi.useFakeTimers();
    const res = new FakeRes();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = streamEvents(asRes(res), async function* () {
      yield ev("start", {});
      await gate;
      yield ev("done", {});
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(1); // the opening ping only
    await vi.advanceTimersByTimeAsync(1);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(4);
    release();
    await done;
    const count = res.chunks.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(res.chunks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a custom heartbeat interval", async () => {
    vi.useFakeTimers();
    const res = new FakeRes();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = streamEvents(asRes(res), async function* () {
      await gate;
    }, { heartbeatMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(3);
    release();
    await done;
  });

  it("a client disconnect aborts the signal, the source still finishes, and later writes are skipped", async () => {
    const res = new FakeRes();
    let seen!: AbortSignal;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = streamEvents(asRes(res), (signal) => {
      seen = signal;
      return (async function* () {
        yield ev("start", {});
        await gate;
        yield ev("text", { target: "intro", index: 0, text: "late" });
      })();
    });
    await vi.waitFor(() => expect(res.body).toContain("event: start"));
    expect(seen.aborted).toBe(false);
    res.destroyed = true;
    res.emit("close"); // the client went away
    expect(seen.aborted).toBe(true);
    release();
    await done;
    expect(res.body).not.toContain("late");
    expect(res.writableEnded).toBe(true);
  });

  it("a close event after the response has ended does not abort", async () => {
    const res = new FakeRes();
    let seen!: AbortSignal;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = streamEvents(asRes(res), (signal) => {
      seen = signal;
      return (async function* () {
        await gate;
      })();
    });
    res.writableEnded = true;
    res.emit("close");
    expect(seen.aborted).toBe(false);
    release();
    await done;
  });

  it("a normal end does not abort the signal", async () => {
    const res = new FakeRes();
    let seen!: AbortSignal;
    await streamEvents(asRes(res), (signal) => {
      seen = signal;
      return (async function* () {})();
    });
    expect(seen.aborted).toBe(false);
  });

  it("turns an unexpected source failure into an error event instead of crashing", async () => {
    const res = new FakeRes();
    await streamEvents(asRes(res), async function* () {
      yield ev("start", {});
      throw new Error("boom with secret sk-123");
    });
    expect(res.body).toContain('event: error\ndata: {"code":"FLO_INTERNAL_ERROR"');
    expect(res.body).not.toContain("sk-123");
    expect(console.error).toHaveBeenCalledWith("[flo] stream failed:", "Error");
    const res2 = new FakeRes();
    await streamEvents(asRes(res2), async function* () {
      throw "x";
    });
    expect(console.error).toHaveBeenCalledWith("[flo] stream failed:", "unknown");
  });

  it("does not end a response that is already ended", async () => {
    const res = new FakeRes();
    const end = vi.spyOn(res, "end");
    await streamEvents(asRes(res), async function* () {
      res.writableEnded = true;
    });
    expect(end).not.toHaveBeenCalled();
  });
});
