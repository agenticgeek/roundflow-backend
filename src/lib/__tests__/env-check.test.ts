import { it, expect } from "vitest";
import { listMissingRecommendedEnv, RECOMMENDED_ENV_VARS, listMissingIntegrationEnv, INTEGRATION_ENV_VARS, OPTIONAL_ENV_VARS } from "../env-check";

it("lists every integration var that is unset or blank", () => {
  const env = Object.fromEntries(INTEGRATION_ENV_VARS.map((n) => [n, "x"])) as NodeJS.ProcessEnv;
  env.STRIPE_CLIENT_ID = "   ";
  delete env.PUBLIC_API_URL;
  expect(listMissingIntegrationEnv(env)).toEqual(["STRIPE_CLIENT_ID", "PUBLIC_API_URL"]);
});

it("returns [] when everything is set, and defaults to process.env", () => {
  const env = Object.fromEntries(INTEGRATION_ENV_VARS.map((n) => [n, "x"])) as NodeJS.ProcessEnv;
  expect(listMissingIntegrationEnv(env)).toEqual([]);
  expect(Array.isArray(listMissingIntegrationEnv())).toBe(true);
});

it("documents optional switches (BE-25) and never reports them as missing", () => {
  expect(Object.keys(OPTIONAL_ENV_VARS)).toContain("EXPOSE_API_DOCS");
  expect(INTEGRATION_ENV_VARS).not.toContain("EXPOSE_API_DOCS" as never);
});

it("lists unset recommended vars (Google geocoding key) and documents the daily limit", () => {
  const SES = ["SES_REGION", "SES_FROM_DOMAIN_ADDRESS", "ANTHROPIC_API_KEY"];
  expect(listMissingRecommendedEnv({} as NodeJS.ProcessEnv)).toEqual(["GOOGLE_MAPS_GEOCODING_API_KEY", ...SES]);
  expect(listMissingRecommendedEnv({ GOOGLE_MAPS_GEOCODING_API_KEY: " " } as NodeJS.ProcessEnv)).toEqual(["GOOGLE_MAPS_GEOCODING_API_KEY", ...SES]);
  expect(listMissingRecommendedEnv({ GOOGLE_MAPS_GEOCODING_API_KEY: "k", SES_REGION: "r", SES_FROM_DOMAIN_ADDRESS: "a@b.co", ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toEqual([]);
  expect(Object.keys(OPTIONAL_ENV_VARS)).toEqual(expect.arrayContaining(["SES_CONFIGURATION_SET", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_SNS_TOPIC_ARN", "EMAIL_DISABLED"]));
  expect(Array.isArray(listMissingRecommendedEnv())).toBe(true);
  expect(Object.keys(RECOMMENDED_ENV_VARS)).toContain("GOOGLE_MAPS_GEOCODING_API_KEY");
  expect(Object.keys(OPTIONAL_ENV_VARS)).toContain("GEOCODE_DAILY_LIMIT");
});

it("Flo AI: the Anthropic key is recommended (unset = Flo disabled) and every Flo switch is documented", () => {
  expect(Object.keys(RECOMMENDED_ENV_VARS)).toContain("ANTHROPIC_API_KEY");
  expect(listMissingRecommendedEnv({} as NodeJS.ProcessEnv)).toContain("ANTHROPIC_API_KEY");
  expect(listMissingRecommendedEnv({ ANTHROPIC_API_KEY: " " } as NodeJS.ProcessEnv)).toContain("ANTHROPIC_API_KEY");
  expect(listMissingRecommendedEnv({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).not.toContain("ANTHROPIC_API_KEY");
  expect(Object.keys(OPTIONAL_ENV_VARS)).toEqual(
    expect.arrayContaining([
      "ANTHROPIC_BASE_URL", "FLO_ENABLED", "FLO_MODEL_THOROUGH", "FLO_MODEL_BALANCED", "FLO_MODEL_QUICK", "FLO_MODEL_SCOPE",
      "FLO_DAILY_LIMIT_PER_TENANT", "FLO_DECLINE_LIMIT_PER_DAY", "RATE_LIMIT_FLO_PER_MIN", "FLO_TIMEOUT_MS", "FLO_RETENTION_DAYS",
    ])
  );
  expect(Object.values(RECOMMENDED_ENV_VARS).join(" ")).not.toMatch(/sk-ant/);
});
