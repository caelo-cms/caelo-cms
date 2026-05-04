// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from "@playwright/test";

/**
 * End-to-end smoke test for the admin shell. Runs against `vite preview`
 * (production build) so the flow exercises the same Bun adapter that ships.
 * One browser (chromium) is enough for the smoke surface; expand in P3+.
 */
export default defineConfig({
  testDir: "./e2e",
  // Custom glob — file ends with `.browser.ts` so Bun's default test runner
  // (which matches `*.test.ts` / `*.spec.ts`) doesn't pick these up during
  // `bun test` in the unit/integration job.
  testMatch: "**/*.browser.ts",
  // globalSetup seeds the dev owner and clears the login rate-limit bucket
  // once before any spec runs. Specs no longer need their own beforeAll hooks
  // for either prerequisite.
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  // P5.2 #1 — chat fixtures live in process memory now (registered via
  // POST /__test/providers, matched by `x-caelo-test-provider` header),
  // so specs no longer share filesystem state and parallel workers are
  // safe again.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    // `vite preview` runs under Node, which doesn't expose the `bun` built-in
    // we import from in `$lib/server/query.ts`. Instead build once, then start
    // the adapter-bun output directly under Bun.
    //
    // ORIGIN is load-bearing: svelte-adapter-bun does not infer it, so without
    // an explicit value SvelteKit's cross-site Origin check 403s every form
    // POST (login, setup, role creation). Behind a real reverse proxy this is
    // the public URL; for the smoke server it's the loopback baseURL.
    command: "bun run build && PORT=4173 ORIGIN=http://localhost:4173 bun run build/index.js",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    // Cold builds on first run can take longer than 120s when node_modules has
    // just been installed. Bump to 240s — local subsequent runs reuse.
    timeout: 240_000,
    env: {
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL ?? "",
      PUBLIC_ADMIN_DATABASE_URL: process.env.PUBLIC_ADMIN_DATABASE_URL ?? "",
      PUBLIC_DATABASE_URL: process.env.PUBLIC_DATABASE_URL ?? "",
      ORIGIN: "http://localhost:4173",
      // NODE_ENV must be unset / non-production for the test-provider
      // registry (`/__test/providers`) to accept registrations. The
      // production build runtime sets NODE_ENV=production by default
      // when invoked through `bun run build/index.js`; we override here
      // so Playwright specs can register fixtures.
      NODE_ENV: "development",
    },
  },
});
