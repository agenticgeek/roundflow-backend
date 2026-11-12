import { describe, expect, it, vi } from "vitest";
import type { ProviderClient } from "../types";

// The service builds the real Anthropic wrapper (once) only when no provider is injected.
const { createAnthropicProvider } = vi.hoisted(() => ({ createAnthropicProvider: vi.fn() }));
vi.mock("../../../integrations/anthropic/client", async (orig) => ({ ...((await orig()) as object), createAnthropicProvider }));

import { createFloService } from "../flo.service";
import { fakeFloDb } from "./fake-flo-db";

describe("default provider", () => {
  it("is created lazily from the env on first use and shared afterwards", async () => {
    const calls: string[] = [];
    const provider: ProviderClient = {
      createMessage: async (req) => {
        calls.push(req.model);
        return { content: [{ type: "text", text: "OUT_OF_SCOPE" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, model: req.model };
      },
      streamMessage: () => {
        throw new Error("not reached");
      },
    };
    createAnthropicProvider.mockReturnValue(provider);
    const env = { ANTHROPIC_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    const svc = createFloService(fakeFloDb().tp, { env });
    for (let i = 0; i < 2; i++) {
      const handle = await svc.prepare({ profileId: "p1", body: { message: "Capital of France?" } });
      const events = [];
      for await (const e of handle.events(new AbortController().signal)) events.push(e.event);
      expect(events).toEqual(["start", "declined", "done"]);
    }
    expect(createAnthropicProvider).toHaveBeenCalledTimes(1);
    expect(createAnthropicProvider).toHaveBeenCalledWith({ env });
    expect(calls).toHaveLength(2);
    expect(createFloService(fakeFloDb().tp)).toBeTruthy(); // default env and clock
  });
});
