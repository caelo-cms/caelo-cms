// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the admin env Settings → MCP → Remote reads, and the
 * Google calls its actions make.
 *
 * `CAELO_E2E_REMOTE_MCP=1` (test-only, ignored when NODE_ENV=production —
 * the same gate as CAELO_E2E_UPDATES_PROVIDER) gives the Playwright suite a
 * Google Cloud install's remote-MCP env without a cloud: setting
 * CAELO_PROVIDER there would switch on real GCP calls elsewhere. Its Google
 * calls fail loudly instead of reaching Google, so a spec sees the same
 * failure surface an install without the version-adder grant would.
 */

import type { RemoteMcpAvailability } from "@caelo-cms/admin-core";
import { remoteMcpAvailability } from "@caelo-cms/admin-core";

/** The fake install the E2E override stands for. */
export const E2E_REMOTE_MCP_ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_MCP_PUBLIC_URL: "https://caelo-production-gateway-e2e-ew.a.run.app",
  CAELO_IAP_AUDIENCE:
    "/projects/123456789012/locations/europe-west1/services/caelo-production-admin-e2e",
  CAELO_MCP_OAUTH_CLIENT_STORE: "projects/caelo-e2e/secrets/caelo-production-mcp-oauth-client",
} as const;

/** Whether this process runs the E2E stand-in. */
export function remoteMcpE2e(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.CAELO_E2E_REMOTE_MCP === "1";
}

/** Remote MCP's availability on this install. */
export function currentRemoteMcpAvailability(
  env: NodeJS.ProcessEnv = process.env,
): RemoteMcpAvailability {
  if (remoteMcpE2e(env)) return remoteMcpAvailability(E2E_REMOTE_MCP_ENV);
  return remoteMcpAvailability({
    CAELO_PROVIDER: env.CAELO_PROVIDER,
    CAELO_MCP_PUBLIC_URL: env.CAELO_MCP_PUBLIC_URL,
    CAELO_IAP_AUDIENCE: env.CAELO_IAP_AUDIENCE,
    CAELO_MCP_OAUTH_CLIENT_STORE: env.CAELO_MCP_OAUTH_CLIENT_STORE,
  });
}

/** Google deps for the E2E stand-in: every call fails, naming why. */
export const E2E_NO_GOOGLE = {
  fetch: (async () => {
    throw new Error("E2E: no Google Cloud in this test run");
  }) as unknown as typeof fetch,
  accessToken: async (): Promise<string> => {
    throw new Error("E2E: no Google Cloud in this test run");
  },
  metadata: async (): Promise<string> => {
    throw new Error("E2E: no Google Cloud in this test run");
  },
};
