import { defineConfig } from "vitest/config";

// Opt-in smoke suite that hits REAL Stripe test-mode / GoCardless sandbox
// APIs. Never part of the default `npm test` / `npm run test:coverage` gate
// (those stay fully mocked and deterministic) — run explicitly via
// `npm run test:live`. Each test skips itself when its required real
// credential env var isn't set, so this is always safe to run without
// credentials (it just reports skipped, not failed).
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    setupFiles: ["src/test/env.setup.ts"],
  },
});
