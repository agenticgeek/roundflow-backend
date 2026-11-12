import type { Mode, ModeConfig } from "./types";

// THOROUGH / BALANCED / QUICK -> model id (env-overridable so a model change needs no deploy), round and output caps,
// and the answer-shape limits of plan 3.5.

export const MODES: readonly Mode[] = ["THOROUGH", "BALANCED", "QUICK"] as const;
export const DEFAULT_MODE: Mode = "BALANCED";

const DEFAULT_MODELS: Record<Mode, string> = {
  THOROUGH: "claude-opus-5-5",
  BALANCED: "claude-sonnet-5-5",
  QUICK: "claude-haiku-5-5",
};
const DEFAULT_SCOPE_MODEL = "claude-haiku-5-5";

const MODE_ENV: Record<Mode, string> = {
  THOROUGH: "FLO_MODEL_THOROUGH",
  BALANCED: "FLO_MODEL_BALANCED",
  QUICK: "FLO_MODEL_QUICK",
};

const STATIC: Record<Mode, Omit<ModeConfig, "model">> = {
  THOROUGH: {
    key: "THOROUGH",
    label: "Thorough",
    description: "Deepest analysis. Slower, best for comparisons and trends.",
    maxRounds: 8,
    maxOutputTokens: 3000,
    maxTables: 3,
    maxCards: 2,
    maxInsights: 6,
    maxIntroSentences: 2,
  },
  BALANCED: {
    key: "BALANCED",
    label: "Balanced",
    description: "Good answers at a good pace. The best choice for most questions.",
    maxRounds: 6,
    maxOutputTokens: 2000,
    maxTables: 2,
    maxCards: 2,
    maxInsights: 4,
    maxIntroSentences: 2,
  },
  QUICK: {
    key: "QUICK",
    label: "Quick",
    description: "One-line answers, fastest.",
    maxRounds: 3,
    maxOutputTokens: 800,
    maxTables: 0,
    maxCards: 1,
    maxInsights: 0,
    maxIntroSentences: 1,
  },
};

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function envModel(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

export function getModeConfig(mode: Mode, env: NodeJS.ProcessEnv = process.env): ModeConfig {
  return { ...STATIC[mode], model: envModel(env, MODE_ENV[mode], DEFAULT_MODELS[mode]) };
}

export function listModes(env: NodeJS.ProcessEnv = process.env): ModeConfig[] {
  return MODES.map((m) => getModeConfig(m, env));
}

export function scopeModel(env: NodeJS.ProcessEnv = process.env): string {
  return envModel(env, "FLO_MODEL_SCOPE", DEFAULT_SCOPE_MODEL);
}

/** Whole-request budget in ms (FLO_TIMEOUT_MS, default 90 s, minimum 5 s). */
export function floTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FLO_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 90_000;
}
