// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — what Settings → Google sign-in's buttons do, in order, so a
 * failure part-way reports exactly which link is missing (setup.ts explains
 * the chain):
 *
 *   save:    validate → Secret Manager version → `operator_oauth.set` →
 *            operator-access sync (IAP oauthSettings) → self-check
 *   remove:  `{}` version → `operator_oauth.clear` → sync (clears IAP's
 *            oauthSettings; IAP falls back to its Google-managed client) →
 *            self-check
 *   check:   sync again → self-check, for "Run the checks again"
 *
 * The secret version comes first: if it fails nothing else changed. The DB
 * row comes before the sync because the sync job reads it. The client
 * secret is passed through to Secret Manager and nowhere else — not into the
 * database, the audit log or any error message.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { googleOAuthClientIdSchema } from "../../ops/security/operator_oauth.js";
import { type OperatorAccessSync, syncOperatorAccess } from "../../ops/user_access.js";
import { defaultGoogleDeps, type GoogleDeps } from "../operator-access/google-iam.js";
import {
  addSecretVersion,
  GOOGLE_OAUTH_CLIENT_SECRET,
  type GoogleSignInAvailability,
  oauthClientFile,
  runSignInSelfCheck,
  type SelfCheckDeps,
  type SelfCheckLine,
} from "./setup.js";

/** The form the Owner submits (step 2 of the setup). */
export const googleSignInClientInputSchema = z.object({
  clientId: googleOAuthClientIdSchema,
  clientSecret: z
    .string()
    .trim()
    .regex(
      GOOGLE_OAUTH_CLIENT_SECRET,
      "paste the client secret exactly as the Google console shows it (it starts with GOCSPX-)",
    ),
});
export type GoogleSignInClientInput = z.infer<typeof googleSignInClientInputSchema>;

export type GoogleSignInConfigureResult =
  | { readonly ok: true; readonly checks: SelfCheckLine[] }
  | {
      readonly ok: false;
      /** Which step failed; earlier steps are done, later ones did not run. */
      readonly step: "secret" | "database";
      readonly error: string;
      readonly nextStep: string;
    };

export interface ConfigureDeps {
  readonly google?: GoogleDeps;
  readonly check?: SelfCheckDeps;
  /** Swaps the sync job in tests; production starts the real one. */
  readonly sync?: () => Promise<OperatorAccessSync>;
  readonly timeoutMs?: number;
}

type Available = Extract<GoogleSignInAvailability, { status: "available" }>;

function secretFailure(e: unknown): GoogleSignInConfigureResult {
  const message = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    step: "secret",
    error: `the client could not be stored in Secret Manager: ${message}`,
    nextStep: /HTTP 403/.test(message)
      ? "The admin may not add versions to the Google sign-in secret yet. Run `cms-provision upgrade` (it grants that), then save again."
      : "Nothing was changed. Try again; if it keeps failing, report it with `bug_report`.",
  };
}

async function finish(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  clientId: string | null,
  removedClientId: string | null,
  deps: ConfigureDeps,
): Promise<GoogleSignInConfigureResult> {
  const sync = await (deps.sync ?? (() => syncOperatorAccess(registry, adapter, ctx)))();
  const checks = await runSignInSelfCheck(deps.check ?? { fetch }, {
    adminUrl: available.adminUrl,
    clientId,
    removedClientId,
    sync,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  return { ok: true, checks };
}

/** Store the Owner's Google sign-in client, hand it to IAP, then self-check. */
export async function saveGoogleSignInClient(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  input: GoogleSignInClientInput,
  deps: ConfigureDeps = {},
): Promise<GoogleSignInConfigureResult> {
  try {
    await addSecretVersion(
      deps.google ?? defaultGoogleDeps(),
      available.secretResource,
      oauthClientFile(input),
    );
  } catch (e) {
    return secretFailure(e);
  }
  const set = await execute(registry, adapter, ctx, "operator_oauth.set", {
    clientId: input.clientId,
  });
  if (!set.ok) {
    return {
      ok: false,
      step: "database",
      error: `the client was stored in Secret Manager, but not recorded: ${JSON.stringify(set.error)}`,
      nextStep:
        "Save again (storing the same client twice is harmless). Until then Google IAP keeps its current sign-in client.",
    };
  }
  return finish(registry, adapter, ctx, available, input.clientId, null, deps);
}

/**
 * Remove the Google sign-in client: the secret becomes `{}`, the row goes,
 * and the sync clears IAP's oauthSettings — IAP signs people in with its
 * Google-managed client again (only the organisation's accounts) and remote
 * MCP stops. The page warns, naming the users who lose access, first.
 */
export async function removeGoogleSignInClient(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  removedClientId: string | null,
  deps: ConfigureDeps = {},
): Promise<GoogleSignInConfigureResult> {
  try {
    await addSecretVersion(
      deps.google ?? defaultGoogleDeps(),
      available.secretResource,
      oauthClientFile(null),
    );
  } catch (e) {
    return secretFailure(e);
  }
  const cleared = await execute(registry, adapter, ctx, "operator_oauth.clear", {});
  if (!cleared.ok) {
    return {
      ok: false,
      step: "database",
      error: `the client was emptied in Secret Manager, but it is still recorded: ${JSON.stringify(cleared.error)}`,
      nextStep:
        "Remove it again. Until then the sync job leaves Google IAP's sign-in client as it is.",
    };
  }
  return finish(registry, adapter, ctx, available, null, removedClientId, deps);
}

/** Re-run the sync and the self-check against what is configured now. */
export async function recheckGoogleSignIn(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  clientId: string | null,
  deps: ConfigureDeps = {},
): Promise<GoogleSignInConfigureResult> {
  return finish(registry, adapter, ctx, available, clientId, null, deps);
}
