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
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run build && bun run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    env: {
      ADMIN_DATABASE_URL: process.env["ADMIN_DATABASE_URL"] ?? "",
      PUBLIC_ADMIN_DATABASE_URL: process.env["PUBLIC_ADMIN_DATABASE_URL"] ?? "",
      PUBLIC_DATABASE_URL: process.env["PUBLIC_DATABASE_URL"] ?? "",
    },
  },
});
