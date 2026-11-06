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

// Recommended (not required): the server starts and the feature degrades. A
// startup warning lists the ones that are unset.
export const RECOMMENDED_ENV_VARS: Record<string, string> = {
  GOOGLE_MAPS_GEOCODING_API_KEY:
    "ACT-10: server-side Google Geocoding API key (Geocoding API only, restrict by server IP; NOT the browser Maps key). Unset = property pins fall back to postcodes.io postcode centres (POSTCODE_FALLBACK)",
};

RECOMMENDED_ENV_VARS.SES_REGION =
  "GHL-03: AWS region of the SES account that sends customer email (e.g. eu-west-2). Unset = customer email is unavailable (409 CHANNEL_UNAVAILABLE); SMS via GHL still works";
RECOMMENDED_ENV_VARS.SES_FROM_DOMAIN_ADDRESS =
  "GHL-03: shared sending address on the RoundFlow-owned, SES-verified subdomain (e.g. notifications@mail.roundflow.ai) used for tier 1 sender identity";

export function listMissingRecommendedEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(RECOMMENDED_ENV_VARS).filter((name) => !env[name] || env[name]!.trim() === "");
}

// Optional switches. Never reported as "missing"; listed here so every env var
// the server reads is documented in one place.
export const OPTIONAL_ENV_VARS: Record<string, string> = {
  EXPOSE_API_DOCS: "BE-25: set to 'true' to serve /docs and /openapi.json when NODE_ENV=production (closed by default in production, open elsewhere)",
  GEOCODE_DAILY_LIMIT: "ACT-10: max Google geocode calls per process per UTC day (default 2000); over it, lookups use postcodes.io only",
  PRECLEAN_REMINDERS_ENABLED: "set to 'true' to run the pre-clean reminder cron",
  RATE_LIMIT_DISABLED: "BE-09: 'true' switches every rate limiter off (default on)",
  RATE_LIMIT_GLOBAL_PER_MIN: "BE-09: requests per IP per minute across the API (default 600; /health exempt)",
  RATE_LIMIT_SIGNUP_PER_HOUR: "BE-09: POST /auth/signup per IP per hour (default 10)",
  RATE_LIMIT_INVITE_PER_MIN: "BE-09: public invite lookup/accept per IP per minute (default 20)",
  RATE_LIMIT_WEBHOOK_PER_MIN: "BE-09: webhook deliveries per IP per minute, counted per source (default 300)",
  TRUST_PROXY: "BE-09: number of proxy hops in front of the API for client-IP detection (default 1 in production, 0 elsewhere)",
  JSON_BODY_LIMIT: "BE-13: max JSON body size, e.g. '100kb' (default); larger bodies get 413 PAYLOAD_TOO_LARGE",
  SES_CONFIGURATION_SET: "GHL-07: SES configuration set that publishes Delivery/Bounce/Complaint events to the SNS topic -> POST /webhooks/ses",
  SES_ACCESS_KEY_ID: "GHL-03: optional static AWS access key for SES (unset = default AWS credential chain / instance role); needs SES_SECRET_ACCESS_KEY too",
  SES_SECRET_ACCESS_KEY: "GHL-03: secret half of SES_ACCESS_KEY_ID (never logged)",
  SES_SNS_TOPIC_ARN: "GHL-07: when set, /webhooks/ses only accepts SNS messages from this topic ARN (recommended in production)",
  EMAIL_DISABLED: "GHL-03: 'true' switches all native customer email off (sends are refused as CHANNEL_UNAVAILABLE); Supabase auth emails are unaffected",
  RATE_LIMIT_EMAIL_ADMIN_PER_HOUR: "Wave 2B-2: /settings/email/* (domain verification, test email) per IP per hour (default 60)",
  OUTBOUND_TIMEOUT_MS: "BE-09: timeout for outbound HTTP calls in ms, minimum 1000 (default 15000; PDF render 60000)",
};
