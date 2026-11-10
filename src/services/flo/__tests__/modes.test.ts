import { describe, expect, it } from "vitest";
import { DEFAULT_MODE, floTimeoutMs, getModeConfig, isMode, listModes, MODES, scopeModel } from "../modes";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("modes", () => {
  it("lists the three modes with plan 3.5 shape limits and Balanced default", () => {
    expect(MODES).toEqual(["THOROUGH", "BALANCED", "QUICK"]);
    expect(DEFAULT_MODE).toBe("BALANCED");
    const [t, b, q] = listModes(env({}));
    expect([t.maxRounds, b.maxRounds, q.maxRounds]).toEqual([8, 6, 3]);
    expect([t.maxTables, b.maxTables, q.maxTables]).toEqual([3, 2, 0]);
    expect([t.maxInsights, q.maxInsights, q.maxCards, q.maxOutputTokens, q.maxIntroSentences]).toEqual([6, 0, 1, 800, 1]);
    expect([t.model, b.model, q.model]).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect([t.label, b.label, q.label]).toEqual(["Thorough", "Balanced", "Quick"]);
  });

  it("env overrides the model id; blank falls back; defaults to process.env", () => {
    expect(getModeConfig("QUICK", env({ FLO_MODEL_QUICK: " my-haiku " })).model).toBe("my-haiku");
    expect(getModeConfig("QUICK", env({ FLO_MODEL_QUICK: "  " })).model).toBe("claude-haiku-5-5");
    expect(typeof getModeConfig("THOROUGH").model).toBe("string");
    expect(listModes()).toHaveLength(3);
    expect(scopeModel(env({}))).toBe("claude-haiku-5-5");
    expect(scopeModel(env({ FLO_MODEL_SCOPE: "x" }))).toBe("x");
    expect(typeof scopeModel()).toBe("string");
  });

  it("validates mode values", () => {
    expect(isMode("QUICK")).toBe(true);
    expect(isMode("quick")).toBe(false);
    expect(isMode(3)).toBe(false);
  });

  it("whole-request budget defaults to 90 s and has a 5 s floor", () => {
    expect(floTimeoutMs(env({}))).toBe(90_000);
    expect(floTimeoutMs(env({ FLO_TIMEOUT_MS: "1000" }))).toBe(90_000);
    expect(floTimeoutMs(env({ FLO_TIMEOUT_MS: "30000.9" }))).toBe(30_000);
    expect(typeof floTimeoutMs()).toBe("number");
  });
});
