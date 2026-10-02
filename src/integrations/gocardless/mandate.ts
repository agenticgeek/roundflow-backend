import type { GcClient } from "./client.js";

export async function createRedirectFlow(
  client: GcClient,
  opts: { successRedirectUrl: string; sessionToken: string; description: string }
): Promise<{ id: string; redirectUrl: string }> {
  const flow = await client.redirectFlows.create({
    session_token: opts.sessionToken,
    success_redirect_url: opts.successRedirectUrl,
    scheme: "bacs",
    description: opts.description,
  });
  return { id: flow.id!, redirectUrl: flow.redirect_url! };
}

export async function completeRedirectFlow(
  client: GcClient,
  redirectFlowId: string,
  sessionToken: string
): Promise<{ gcCustomerId: string; mandateId: string }> {
  const flow = await client.redirectFlows.complete(redirectFlowId, {
    session_token: sessionToken,
  });
  return {
    gcCustomerId: flow.links!.customer!,
    mandateId: flow.links!.mandate!,
  };
}
