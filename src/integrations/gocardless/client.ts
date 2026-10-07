// @ts-expect-error — gocardless-nodejs ships ESM as main but has a CJS build under require condition
import { GoCardlessClient, Environments } from "gocardless-nodejs";

export function getGcClient(accessToken: string, environment: string): GoCardlessClient {
  return new GoCardlessClient(
    accessToken,
    environment === "live" ? Environments.Live : Environments.Sandbox
  );
}

export type GcClient = ReturnType<typeof getGcClient>;
