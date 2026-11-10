import Anthropic from "@anthropic-ai/sdk";
import { outboundSignal } from "../../lib/outbound";
import { floTimeoutMs } from "../../services/flo/modes";
import type {
  ProviderClient,
  ProviderContentBlock,
  ProviderErrorCode,
  ProviderRequest,
  ProviderResponse,
  ProviderStopReason,
  ProviderStreamEvent,
  ProviderUsage,
} from "../../services/flo/types";

// Thin, injectable wrapper over the Anthropic SDK (Flo AI, D7). Guarantees:
//  - every call has a timeout (outboundSignal) and honours the caller's abort signal;
//  - ONE retry on 529 / 5xx / network errors, only before the first byte of a response (never after content started);
//  - no retry on 4xx, none on timeout or abort;
//  - errors are mapped to ProviderError with a fixed message: the SDK error text is never copied, so neither the API
//    key nor any request body can leak into logs or responses. This module never logs anything;
//  - ANTHROPIC_BASE_URL is honoured (mock server / proxy).

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The slice of the SDK this wrapper uses; tests inject a scripted fake. */
export interface SdkLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(params: any, options?: { signal?: AbortSignal }): Promise<any>;
  };
}

export interface AnthropicProviderOptions {
  sdk?: SdkLike;
  apiKey?: string;
  baseURL?: string;
  /** Per-call timeout in ms (default FLO_TIMEOUT_MS = 90 s). */
  timeoutMs?: number;
  /** Delay before the single retry (default 400 ms). */
  retryDelayMs?: number;
  env?: NodeJS.ProcessEnv;
}

const STOP_REASONS: Record<string, ProviderStopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

function mapStopReason(raw: unknown): ProviderStopReason {
  return (typeof raw === "string" && STOP_REASONS[raw]) || "other";
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

function mapError(err: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (callerSignal?.aborted) return new ProviderError("PROVIDER_ABORTED", "The request was cancelled");
  if (timeoutSignal.aborted) return new ProviderError("PROVIDER_TIMEOUT", "The AI service timed out", undefined, true);
  const status = statusOf(err);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return new ProviderError("PROVIDER_REJECTED", `The AI service rejected the request (${status})`, status);
  }
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    status === undefined ? "The AI service could not be reached" : `The AI service is unavailable (${status})`,
    status,
    true
  );
}

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

function toUsage(usage: RawUsage | undefined, base?: ProviderUsage): ProviderUsage {
  return {
    inputTokens: usage?.input_tokens ?? base?.inputTokens ?? 0,
    outputTokens: usage?.output_tokens ?? base?.outputTokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens ?? base?.cachedTokens ?? 0,
  };
}

function buildParams(req: ProviderRequest): Record<string, unknown> {
  const cache = req.cache !== false;
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: cache ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] : req.system,
    messages: req.messages,
  };
  if (req.tools && req.tools.length > 0) {
    const last = req.tools.length - 1;
    params.tools = req.tools.map((t, i) => (cache && i === last ? { ...t, cache_control: { type: "ephemeral" } } : t));
  }
  return params;
}

function toContent(raw: unknown): ProviderContentBlock[] {
  const out: ProviderContentBlock[] = [];
  for (const b of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
    if (b.type === "text") out.push({ type: "text", text: String(b.text) });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input });
  }
  return out;
}

function parseJson(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

interface OpenBlock {
  type: string;
  id?: string;
  name?: string;
  text: string;
  json: string;
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): ProviderClient {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? floTimeoutMs(env);
  const retryDelayMs = opts.retryDelayMs ?? 400;
  let sdk: SdkLike | undefined = opts.sdk;

  const getSdk = (): SdkLike => {
    if (sdk) return sdk;
    const apiKey = opts.apiKey ?? env.ANTHROPIC_API_KEY;
    if (!apiKey?.trim()) throw new ProviderError("PROVIDER_UNAVAILABLE", "The AI service is not configured");
    const baseURL = opts.baseURL ?? (env.ANTHROPIC_BASE_URL?.trim() || undefined);
    // maxRetries 0: retries are done here so the "before the first byte" rule is exact.
    sdk = new Anthropic({ apiKey, baseURL, maxRetries: 0 }) as unknown as SdkLike;
    return sdk;
  };

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Signals for one attempt: the caller's abort plus a fresh timeout.
  const signals = (req: ProviderRequest) => {
    const timeout = outboundSignal(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    return { signal, timeout };
  };

  async function createMessage(req: ProviderRequest): Promise<ProviderResponse> {
    const params = buildParams(req);
    for (let attempt = 0; ; attempt++) {
      const { signal, timeout } = signals(req);
      try {
        const msg = await getSdk().messages.create(params, { signal });
        return {
          content: toContent(msg.content),
          stopReason: mapStopReason(msg.stop_reason),
          usage: toUsage(msg.usage),
          model: String(msg.model),
        };
      } catch (err) {
        const mapped = mapError(err, req.signal, timeout);
        if (attempt === 0 && mapped.code === "PROVIDER_UNAVAILABLE") {
          await wait(retryDelayMs);
          continue;
        }
        throw mapped;
      }
    }
  }

  async function* streamMessage(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void> {
    const params = { ...buildParams(req), stream: true };
    for (let attempt = 0; ; attempt++) {
      const { signal, timeout } = signals(req);
      let gotFirstByte = false;
      try {
        const stream: AsyncIterable<Record<string, unknown>> = await getSdk().messages.create(params, { signal });
        const blocks = new Map<number, OpenBlock>();
        const done: ProviderContentBlock[] = [];
        let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
        let stopReason: ProviderStopReason = "other";
        for await (const ev of stream) {
          gotFirstByte = true;
          const idx = ev.index as number;
          if (ev.type === "message_start") {
            usage = toUsage((ev.message as { usage?: RawUsage }).usage);
          } else if (ev.type === "content_block_start") {
            const cb = ev.content_block as { type: string; id?: string; name?: string };
            blocks.set(idx, { type: cb.type, id: cb.id, name: cb.name, text: "", json: "" });
          } else if (ev.type === "content_block_delta") {
            const b = blocks.get(idx);
            const d = ev.delta as { type: string; text?: string; partial_json?: string };
            if (b && d.type === "text_delta") {
              b.text += d.text;
              yield { type: "text_delta", text: String(d.text) };
            } else if (b && d.type === "input_json_delta") {
              b.json += d.partial_json;
            }
          } else if (ev.type === "content_block_stop") {
            const b = blocks.get(idx);
            if (b?.type === "text") done.push({ type: "text", text: b.text });
            if (b?.type === "tool_use") {
              const call = { type: "tool_use" as const, id: String(b.id), name: String(b.name), input: parseJson(b.json) };
              done.push(call);
              yield call;
            }
          } else if (ev.type === "message_delta") {
            const delta = ev.delta as { stop_reason?: string };
            if (delta.stop_reason) stopReason = mapStopReason(delta.stop_reason);
            usage = toUsage(ev.usage as RawUsage | undefined, usage);
          }
        }
        yield { type: "message_end", stopReason, usage, content: done };
        return;
      } catch (err) {
        const mapped = mapError(err, req.signal, timeout);
        if (!gotFirstByte && attempt === 0 && mapped.code === "PROVIDER_UNAVAILABLE") {
          await wait(retryDelayMs);
          continue;
        }
        throw mapped;
      }
    }
  }

  return { createMessage, streamMessage };
}
