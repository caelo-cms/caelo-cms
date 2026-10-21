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
 *
 * #967 — the preflight's calls to Google's public OAuth endpoints are
 * answered by {@link E2E_GOOGLE_OAUTH}: Google's recorded responses
 * (admin-core recorded-google-oauth.json), so the suite sees exactly what
 * Google sends. Which answer a client gets depends on its ID, so a spec
 * picks the case by the client it types.
 *
 * #970 — {@link bootstrapE2eOperatorAccess} stands in for the operator-access
 * sync job (no Cloud Run): its runs refuse `no-google-…` addresses the way
 * Google refuses an address without a Google account.
 */

import type {
  GoogleSignInAvailability,
  OperatorAccessTrigger,
  RemoteMcpAvailability,
} from "@caelo-cms/admin-core";
import {
  classifySyncRun,
  googleSignInAvailability,
  recordedGoogleOAuthFetch,
  remoteMcpAvailability,
  setOperatorAccessTriggerForTests,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { GOOGLE_OAUTH_CLIENT_ID, iapRedirectUri } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

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

/**
 * #967 — Google's OAuth endpoints for the E2E stand-in, replaying recorded
 * answers. A client ID containing `unknown` does not exist; one containing
 * `noiap` lacks IAP's redirect URI (redirect URI 2); the secret
 * `GOCSPX-e2e-wrong-secret` is wrong for every client.
 */
const E2E_CLIENTS = {
  exists: (id: string) => GOOGLE_OAUTH_CLIENT_ID.test(id) && !id.includes("unknown"),
  registered: (id: string, uri: string) => !(id.includes("noiap") && uri === iapRedirectUri(id)),
  secretValid: (_id: string, secret: string) => secret !== "GOCSPX-e2e-wrong-secret",
};
export const E2E_GOOGLE_OAUTH = { fetch: recordedGoogleOAuthFetch(E2E_CLIENTS) };

/** The self-check in the E2E stand-in: recorded Google, the (unreachable) fake admin URL as before. */
export const E2E_SELF_CHECK = { fetch: recordedGoogleOAuthFetch(E2E_CLIENTS, fetch) };

/** Users the E2E stand-in's Google has no account for: the local part starts with this. */
export const E2E_NO_GOOGLE_ACCOUNT_PREFIX = "no-google-";

/**
 * #970 — the operator-access sync job in the E2E stand-in. A run "applies"
 * the user list at once, refuses every member whose address starts with
 * {@link E2E_NO_GOOGLE_ACCOUNT_PREFIX} (Google's "User … does not exist"),
 * and records its report through the same op the real job uses, so
 * /settings/users and the create form read a real report row.
 */
function e2eOperatorAccessTrigger(): OperatorAccessTrigger {
  let runs = 0;
  let last: string | null = null;
  const logsUrl = (execution: string) => `https://console.cloud.google.com/e2e/${execution}`;
  const system = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system" as const,
    requestId: "e2e-operator-access",
  };
  return {
    label: "Google IAP (E2E stand-in)",
    async start() {
      runs += 1;
      last = `e2e-operator-access-sync-${Date.now().toString(36)}-${runs}`;
      return last;
    },
    async wait(execution) {
      const { adapter, registry } = getQueryContext();
      const members = await execute(registry, adapter, system, "users.operator_access_members", {});
      if (!members.ok) throw new Error(JSON.stringify(members.error));
      const refused = (members.value as { emails: string[] }).emails.filter((e) =>
        e.startsWith(E2E_NO_GOOGLE_ACCOUNT_PREFIX),
      );
      const recorded = await execute(
        registry,
        adapter,
        system,
        "users.record_operator_access_run",
        {
          execution,
          outcome: classifySyncRun({ refusedMembers: refused, errorCount: 0 }),
          refusedMembers: refused,
          errorCount: 0,
          signInClientProblem: null,
        },
      );
      if (!recorded.ok) throw new Error(JSON.stringify(recorded.error));
      return {
        execution,
        state: "succeeded",
        completedAt: new Date().toISOString(),
        logsUrl: logsUrl(execution),
      };
    },
    async latest() {
      return last ? { execution: last, state: "succeeded", logsUrl: logsUrl(last) } : null;
    },
  };
}

/** Install the E2E sync-job stand-in (a no-op outside CAELO_E2E_GOOGLE_IAP). */
export function bootstrapE2eOperatorAccess(env: NodeJS.ProcessEnv = process.env): void {
  if (!googleIapE2e(env)) return;
  setOperatorAccessTriggerForTests({ trigger: e2eOperatorAccessTrigger() });
}
