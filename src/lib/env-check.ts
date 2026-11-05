// D-10 / A6: integration env vars the server reads at request time. A missing
// one doesn't stop the server starting, it just breaks that integration (e.g.
// webhook URLs render as "undefined/webhooks/..."), so startup logs a warning
// listing them instead. GoCardless and GHL tokens are per tenant (stored
// encrypted in BusinessSettings), so only the platform-level values are here.
export const INTEGRATION_ENV_VARS = [
  "STRIPE_SECRET_KEY",              // Stripe Connect token exchange
  "STRIPE_CLIENT_ID",               // Stripe Connect authorize URL
  "STRIPE_CONNECT_WEBHOOK_SECRET",  // POST /webhooks/stripe signature check
  "GHL_CLIENT_ID",                  // GHL OAuth authorize + token exchange/refresh
  "GHL_CLIENT_SECRET",
  "ENCRYPTION_KEY",                 // encrypts stored provider tokens, signs OAuth state
  "PUBLIC_API_URL",                 // webhook URLs handed to GoCardless/GHL, GHL redirect URI
  "FRONTEND_URL",                   // post-connect redirects back to the web app
] as const;

export function listMissingIntegrationEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return INTEGRATION_ENV_VARS.filter((name) => !env[name] || env[name]!.trim() === "");
}
