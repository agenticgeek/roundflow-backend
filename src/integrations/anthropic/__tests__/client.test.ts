import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider, ProviderError, type SdkLike } from "../client";
import type { ProviderRequest, ProviderStreamEvent } from "../../../services/flo/types";

const SECRET = "sk-ant-test-CANARY-SECRET";
const BASE: ProviderRequest = {
  model: "claude-sonnet-5-5",
  system: "SYSTEM",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
};
const TOOLS = [
  { name: "a", description: "A", input_schema: { type: "object" as const, properties: {}, additionalProperties: false as const } },
  { name: "b", description: "B", input_schema: { type: "object" as const, properties: {}, additionalProperties: false as const } },
];

async function* events(list: Array<Record<string, unknown>>, failAfter?: unknown): AsyncGenerator<Record<string, unknown>> {
  for (const e of list) yield e;
  if (failAfter) throw failAfter;
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status} body with ${SECRET}`), { status });

const goodStream = [
  { type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 4, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "list_debtors" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"minBal' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ance":50}' } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu2", name: "x" } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu3", name: "y" } },
  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{bad" } },
  { type: "content_block_stop", index: 3 },
  { type: "content_block_start", index: 4, content_block: { type: "thinking" } },
  { type: "content_block_delta", index: 4, delta: { type: "thinking_delta", thinking: "..." } },
  { type: "content_block_stop", index: 4 },
  { type: "content_block_stop", index: 9 },
  { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "ghost" } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_delta", delta: {}, usage: undefined },
  { type: "message_stop" },
];

async function collect(gen: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sdkWith(create: (...a: any[]) => Promise<any>): { sdk: SdkLike; create: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(create);
  return { sdk: { messages: { create: fn } }, create: fn };
}

const provider = (sdk: SdkLike, extra = {}) => createAnthropicProvider({ sdk, retryDelayMs: 0, timeoutMs: 5000, ...extra });

describe("createMessage", () => {
  it("builds the request with cache breakpoints and maps the response", async () => {
    const { sdk, create } = sdkWith(async () => ({
      model: "claude-sonnet-5-5-x",
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "n", input: { a: 1 } },
        { type: "thinking", thinking: "dropped" },
      ],
    }));
    const res = await provider(sdk).createMessage({ ...BASE, tools: TOOLS });
    expect(res).toEqual({
      model: "claude-sonnet-5-5-x",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 7, cachedTokens: 2 },
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t1", name: "n", input: { a: 1 } },
      ],
    });
    const [params, opts] = create.mock.calls[0] as [Record<string, unknown>, { signal: AbortSignal }];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(100);
    expect(params.stream).toBeUndefined();
    expect(params.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
    const tools = params.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits cache_control and tools when asked / empty; maps missing usage and unknown stop reasons", async () => {
    const { sdk, create } = sdkWith(async () => ({ model: "m", stop_reason: "pause_turn", content: "not-an-array" }));
    const res = await provider(sdk).createMessage({ ...BASE, cache: false, tools: [] });
    expect(res.stopReason).toBe("other");
    expect(res.content).toEqual([]);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    const [params] = create.mock.calls[0] as [Record<string, unknown>];
    expect(params.system).toBe("SYSTEM");
    expect(params.tools).toBeUndefined();
  });

  it("maps stop_sequence, max_tokens, refusal and a non-string stop reason", async () => {
    for (const [raw, mapped] of [["stop_sequence", "end_turn"], ["max_tokens", "max_tokens"], ["refusal", "refusal"], [null, "other"]] as const) {
      const { sdk } = sdkWith(async () => ({ model: "m", stop_reason: raw, content: [] }));
      expect((await provider(sdk).createMessage(BASE)).stopReason).toBe(mapped);
    }
  });

  it("retries once on a 529 and succeeds", async () => {
    let n = 0;
    const { sdk, create } = sdkWith(async () => {
      if (n++ === 0) throw httpError(529);
      return { model: "m", stop_reason: "end_turn", content: [] };
    });
    await expect(provider(sdk).createMessage(BASE)).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries once on a network error (no status) and then maps to PROVIDER_UNAVAILABLE", async () => {
    const { sdk, create } = sdkWith(async () => {
      throw new Error("ECONNRESET " + SECRET);
    });
    const err = await provider(sdk).createMessage(BASE).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, status: undefined });
    expect(create).toHaveBeenCalledTimes(2);
    expect(String(err.message)).not.toContain(SECRET);
  });

  it("gives up after the one retry on 5xx and never leaks the SDK message", async () => {
    const { sdk, create } = sdkWith(async () => {
      throw httpError(503);
    });
    const err = await provider(sdk).createMessage(BASE).catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 503 });
    expect(err.message).not.toContain(SECRET);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx; it is PROVIDER_REJECTED. 429 is treated as unavailable", async () => {
    const a = sdkWith(async () => {
      throw httpError(400);
    });
    const err = await provider(a.sdk).createMessage(BASE).catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_REJECTED", status: 400, retryable: false });
    expect(a.create).toHaveBeenCalledTimes(1);
    const b = sdkWith(async () => {
      throw httpError(429);
    });
    await expect(provider(b.sdk).createMessage(BASE)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 429 });
  });

  it("maps a caller abort to PROVIDER_ABORTED without retrying", async () => {
    const ac = new AbortController();
    const { sdk, create } = sdkWith(async () => {
      ac.abort();
      throw new Error("aborted");
    });
    await expect(provider(sdk).createMessage({ ...BASE, signal: ac.signal })).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps its own timeout to PROVIDER_TIMEOUT without retrying", async () => {
    const { sdk, create } = sdkWith(
      (_p, opts) =>
        new Promise((_res, rej) => {
          (opts as { signal: AbortSignal }).signal.addEventListener("abort", () => rej(new Error("timeout")));
        })
    );
    const err = await createAnthropicProvider({ sdk, timeoutMs: 20, retryDelayMs: 0 }).createMessage(BASE).catch((e) => e);
    expect(err).toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("passes a ProviderError through unchanged", async () => {
    const pe = new ProviderError("PROVIDER_REJECTED", "x");
    const { sdk } = sdkWith(async () => {
      throw pe;
    });
    await expect(provider(sdk).createMessage(BASE)).rejects.toBe(pe);
  });

  it("uses the default timeout from the environment when none is given", async () => {
    const { sdk } = sdkWith(async () => ({ model: "m", stop_reason: "end_turn", content: [] }));
    await expect(createAnthropicProvider({ sdk, env: { FLO_TIMEOUT_MS: "20000" } as NodeJS.ProcessEnv }).createMessage(BASE)).resolves.toBeTruthy();
    await expect(createAnthropicProvider({ sdk, retryDelayMs: undefined }).createMessage(BASE)).resolves.toBeTruthy();
  });
});

describe("streamMessage", () => {
  it("maps raw SDK events to text deltas, complete tool calls and a final message_end", async () => {
    const { sdk, create } = sdkWith(async () => events(goodStream));
    const out = await collect(provider(sdk).streamMessage({ ...BASE, tools: TOOLS }));
    expect(out.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
    ]);
    expect(out.filter((e) => e.type === "tool_use")).toEqual([
      { type: "tool_use", id: "tu1", name: "list_debtors", input: { minBalance: 50 } },
      { type: "tool_use", id: "tu2", name: "x", input: {} },
      { type: "tool_use", id: "tu3", name: "y", input: {} },
    ]);
    const end = out[out.length - 1];
    expect(end).toEqual({
      type: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 11, outputTokens: 42, cachedTokens: 4 },
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "tu1", name: "list_debtors", input: { minBalance: 50 } },
        { type: "tool_use", id: "tu2", name: "x", input: {} },
        { type: "tool_use", id: "tu3", name: "y", input: {} },
      ],
    });
    expect((create.mock.calls[0][0] as Record<string, unknown>).stream).toBe(true);
  });

  it("retries once when the failure happens before the first byte", async () => {
    let n = 0;
    const { sdk, create } = sdkWith(async () => {
      if (n++ === 0) throw httpError(529);
      return events([{ type: "message_stop" }]);
    });
    const out = await collect(provider(sdk).streamMessage(BASE));
    expect(out).toEqual([{ type: "message_end", stopReason: "other", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, content: [] }]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry after the first byte; the error is mapped and thrown", async () => {
    const { sdk, create } = sdkWith(async () => events([{ type: "message_start", message: {} }], httpError(500)));
    const gen = provider(sdk).streamMessage(BASE);
    await expect(collect(gen)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", status: 500 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 4xx and gives up after one retry on repeated 5xx", async () => {
    const a = sdkWith(async () => {
      throw httpError(401);
    });
    await expect(collect(provider(a.sdk).streamMessage(BASE))).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(a.create).toHaveBeenCalledTimes(1);
    const b = sdkWith(async () => {
      throw httpError(502);
    });
    await expect(collect(provider(b.sdk).streamMessage(BASE))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(b.create).toHaveBeenCalledTimes(2);
  });

  it("maps a caller abort mid-stream to PROVIDER_ABORTED", async () => {
    const ac = new AbortController();
    const { sdk } = sdkWith(async () =>
      (async function* () {
        yield { type: "message_start", message: {} };
        ac.abort();
        throw new Error("aborted");
      })()
    );
    await expect(collect(provider(sdk).streamMessage({ ...BASE, signal: ac.signal }))).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
  });
});

describe("construction and secrets", () => {
  it("is unavailable (no SDK call) when no key is configured", async () => {
    const p = createAnthropicProvider({ env: {} as NodeJS.ProcessEnv });
    await expect(p.createMessage(BASE)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("builds a real SDK client lazily with the key and ANTHROPIC_BASE_URL, once", async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const fetchStub = vi.fn(async (url: unknown, init?: { headers?: unknown }) => {
      const h = init?.headers as unknown;
      const pairs: Array<[string, string]> = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? (h as Array<[string, string]>) : Object.entries((h ?? {}) as Record<string, string>);
      const auth = pairs.filter(([k]) => ["x-api-key", "authorization"].includes(k.toLowerCase())).map(([, v]) => v).join(" ");
      seen = { url: String(url), auth };
      return new Response(
        JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const p = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: "http://mock.local:9999" } as NodeJS.ProcessEnv });
      await p.createMessage(BASE);
      await p.createMessage(BASE);
      expect(seen?.url.startsWith("http://mock.local:9999/")).toBe(true);
      expect(seen?.auth).toContain(SECRET);
      const p2 = createAnthropicProvider({ apiKey: SECRET, baseURL: "http://other.local" });
      await p2.createMessage(BASE);
      expect(seen?.url.startsWith("http://other.local/")).toBe(true);
      const p3 = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: "  " } as NodeJS.ProcessEnv });
      await p3.createMessage(BASE);
      expect(seen?.url.startsWith("https://api.anthropic.com/")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never writes the key to the console, even on failure", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { sdk } = sdkWith(async () => {
      throw httpError(500);
    });
    await provider(sdk).createMessage({ ...BASE, system: SECRET }).catch(() => {});
    await collect(provider(sdk).streamMessage(BASE)).catch(() => {});
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
