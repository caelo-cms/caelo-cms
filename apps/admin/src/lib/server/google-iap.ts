// SPDX-License-Identifier: MPL-2.0

/**
 * Issues #806 / #914 — the admin env Settings → Google sign-in and
 * Settings → MCP → Remote read, and the Google calls their actions make.
 *
 * `CAELO_E2E_GOOGLE_IAP=1` (test-only, ignored when NODE_ENV=production —
 * the same gate as CAELO_E2E_UPDATES_PROVIDER) gives the Playwright suite a
 * Google Cloud install's env without a cloud: setting CAELO_PROVIDER there
 * would switch on real GCP calls elsewhere. Its Google calls fail loudly
 * instead of reaching Google, so a spec sees the same failure surface an
 * install without the version-adder grant would.
 */

import type { GoogleSignInAvailability, RemoteMcpAvailability } from "@caelo-cms/admin-core";
import { googleSignInAvailability, remoteMcpAvailability } from "@caelo-cms/admin-core";

/** The fake install the E2E override stands for. */
export const E2E_GOOGLE_IAP_ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_ADMIN_URL: "https://caelo-production-admin-e2e-ew.a.run.app",
  CAELO_MCP_PUBLIC_URL: "https://caelo-production-gateway-e2e-ew.a.run.app",
  CAELO_IAP_AUDIENCE:
    "/projects/123456789012/locations/europe-west1/services/caelo-production-admin-e2e",
  CAELO_OPERATOR_OAUTH_CLIENT_STORE:
    "projects/caelo-e2e/secrets/caelo-production-operator-oauth-client",
  // The seeded dev users are @example.com: in the organisation.
  CAELO_GOOGLE_ORG_DOMAIN: "example.com",
} as const;

/** Whether this process runs the E2E stand-in. */
export function googleIapE2e(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.CAELO_E2E_GOOGLE_IAP === "1";
}

/** Google sign-in's availability on this install. */
export function currentGoogleSignInAvailability(
  env: NodeJS.ProcessEnv = process.env,
): GoogleSignInAvailability {
  if (googleIapE2e(env)) return googleSignInAvailability(E2E_GOOGLE_IAP_ENV);
  return googleSignInAvailability({
    CAELO_PROVIDER: env.CAELO_PROVIDER,
    CAELO_ADMIN_URL: env.CAELO_ADMIN_URL,
    CAELO_MCP_PUBLIC_URL: env.CAELO_MCP_PUBLIC_URL,
    CAELO_OPERATOR_OAUTH_CLIENT_STORE: env.CAELO_OPERATOR_OAUTH_CLIENT_STORE,
    CAELO_GOOGLE_ORG_DOMAIN: env.CAELO_GOOGLE_ORG_DOMAIN,
  });
}

/** Remote MCP's availability on this install. */
export function currentRemoteMcpAvailability(
  env: NodeJS.ProcessEnv = process.env,
): RemoteMcpAvailability {
  if (googleIapE2e(env)) return remoteMcpAvailability(E2E_GOOGLE_IAP_ENV);
  return remoteMcpAvailability({
    CAELO_PROVIDER: env.CAELO_PROVIDER,
    CAELO_MCP_PUBLIC_URL: env.CAELO_MCP_PUBLIC_URL,
    CAELO_IAP_AUDIENCE: env.CAELO_IAP_AUDIENCE,
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
