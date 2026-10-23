// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — what Settings → Google sign-in's buttons do, in order, so a
 * failure part-way reports exactly which link is missing (setup.ts explains
 * the chain):
 *
 *   preflight: validate → ask Google whether both redirect URIs are on the
 *            client and the secret is the client's (#967, preflight.ts) —
 *            nothing is stored, IAP is untouched
 *   save:    validate → the Owner confirmed that everyone signs in once
 *            more → the same preflight again (a stale tab, a URI removed
 *            since) → Secret Manager version → `operator_oauth.set` →
 *            operator-access sync (IAP oauthSettings) → self-check
 *   remove:  `{}` version → `operator_oauth.clear` → sync (clears IAP's
 *            oauthSettings; IAP falls back to its Google-managed client) →
 *            self-check
 *   check:   sync again → self-check, for "Run the checks again"
 *
 * A failed preflight stores nothing: IAP switches clients only once Google
 * confirmed the client is complete, because switching signs everybody out
 * and a client without IAP's redirect URI keeps everybody out (IAP error
 * code 9). The secret version comes next: if it fails nothing else changed. The DB
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
  type PreflightDeps,
  type PreflightLine,
  preflightFailureSummary,
  runClientPreflight,
} from "./preflight.js";
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
  /**
   * The Owner confirmed the consent screen is External + In production —
   * Google offers no way to check that from outside its console (preflight.ts).
   */
  consentConfirmed: z.boolean(),
  /**
   * The Owner confirmed "every user signs in to the admin once more" —
   * required to store the client, not to check it.
   */
  reLoginConfirmed: z.boolean().default(false),
});
export type GoogleSignInClientInput = z.infer<typeof googleSignInClientInputSchema>;

/** Why a save without the re-login confirmation changes nothing. */
export const RE_LOGIN_NOT_CONFIRMED =
  "Confirm the switch first: with a new Google sign-in client every user signs in to the admin once more.";

export type GoogleSignInConfigureResult =
  | { readonly ok: true; readonly checks: SelfCheckLine[] }
  | {
      readonly ok: false;
      /**
       * Which step failed; earlier steps are done, later ones did not run.
       * `confirm` / `preflight` = nothing was stored and IAP was not touched.
       */
      readonly step: "confirm" | "preflight" | "secret" | "database";
      readonly error: string;
      readonly nextStep: string;
      /** The preflight's lines when `step` is `preflight`. */
      readonly checks?: readonly PreflightLine[];
    };

/** The preflight on its own (Settings → Google sign-in's "Check the client"). */
export type GoogleSignInPreflightResult =
  | { readonly ok: true; readonly checks: readonly PreflightLine[] }
  | {
      readonly ok: false;
      readonly step: "preflight";
      readonly error: string;
      readonly nextStep: string;
      readonly checks: readonly PreflightLine[];
    };

export interface ConfigureDeps {
  readonly google?: GoogleDeps;
  readonly check?: SelfCheckDeps;
  /** Swaps the sync job in tests; production starts the real one. */
  readonly sync?: () => Promise<OperatorAccessSync>;
  readonly timeoutMs?: number;
  /** Google's public OAuth endpoints for the preflight (#967); production uses `fetch`. */
  readonly preflight?: PreflightDeps;
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
    redirectUris: {
      projectId: available.projectId,
      brokerRedirectUri: available.brokerRedirectUri,
    },
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  });
  return { ok: true, checks };
}

/**
 * Check the client against Google without storing or applying anything
 * (#967). Every failing line carries the exact fix.
 */
export async function preflightGoogleSignInClient(
  available: Available,
  input: GoogleSignInClientInput,
  deps: ConfigureDeps = {},
): Promise<GoogleSignInPreflightResult> {
  const result = await runClientPreflight(deps.preflight ?? { fetch }, {
    projectId: available.projectId,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    brokerRedirectUri: available.brokerRedirectUri,
    consentConfirmed: input.consentConfirmed,
  });
  if (result.ok) return { ok: true, checks: result.lines };
  return { ok: false, step: "preflight", ...preflightFailureSummary(result), checks: result.lines };
}

/**
 * Store the Owner's Google sign-in client, hand it to IAP, then self-check —
 * only once the Owner confirmed the re-login and the client passed the
 * preflight. Replacing or rotating a client goes through the same path.
 */
export async function saveGoogleSignInClient(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  input: GoogleSignInClientInput,
  deps: ConfigureDeps = {},
): Promise<GoogleSignInConfigureResult> {
  if (!input.reLoginConfirmed) {
    return {
      ok: false,
      step: "confirm",
      error: RE_LOGIN_NOT_CONFIRMED,
      nextStep: 'Click "Check the client", read the notice, then confirm the switch.',
    };
  }
  const preflight = await preflightGoogleSignInClient(available, input, deps);
  if (!preflight.ok) return preflight;
  try {
    await addSecretVersion(
      deps.google ?? defaultGoogleDeps(),
      available.secretResource,
      oauthClientFile({ clientId: input.clientId, clientSecret: input.clientSecret }),
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
