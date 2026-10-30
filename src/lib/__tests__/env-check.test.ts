import { it, expect } from "vitest";
import { listMissingIntegrationEnv, INTEGRATION_ENV_VARS } from "../env-check";

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
