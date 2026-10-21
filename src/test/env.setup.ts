// Shared test environment — loaded via vitest's `setupFiles` so every test
// file gets a consistent, deterministic env without redefining it locally.
// A fixed 64-hex-char key (32 bytes) so src/lib/crypto.ts's encrypt/decrypt
// round-trip is deterministic in tests; it is not a real secret.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
process.env.FRONTEND_URL ??= "https://app.test.roundflow.example";
process.env.PUBLIC_API_URL ??= "https://api.test.roundflow.example";
process.env.STRIPE_CLIENT_ID ??= "ca_test_client_id";
process.env.STRIPE_SECRET_KEY ??= "sk_test_platform_secret";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET ??= "whsec_test_connect_webhook_secret";
