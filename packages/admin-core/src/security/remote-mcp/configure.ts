// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — what Settings → MCP → Remote's buttons do, in order, so a
 * failure part-way reports exactly which link is missing (setup.ts explains
 * the chain):
 *
 *   save:  validate → Secret Manager version → `mcp_remote_oauth.set` →
 *          operator-access sync (IAP programmatic_clients) → self-check
 *   off:   `{}` version → `mcp_remote_oauth.clear` → sync (clears the list)
 *          → self-check (the gateway reports "not configured")
 *   check: sync again → self-check, for "Run the checks again"
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
import { googleOAuthClientIdSchema } from "../../ops/security/mcp_remote_oauth.js";
import { type OperatorAccessSync, syncOperatorAccess } from "../../ops/user_access.js";
import { defaultGoogleDeps, type GoogleDeps } from "../operator-access/google-iam.js";
import {
  addSecretVersion,
  GOOGLE_OAUTH_CLIENT_SECRET,
  oauthClientFile,
  type RemoteMcpAvailability,
  runSelfCheck,
  type SelfCheckDeps,
  type SelfCheckLine,
} from "./setup.js";

/** The form the Owner submits (step 2 of the setup). */
export const remoteMcpClientInputSchema = z.object({
  clientId: googleOAuthClientIdSchema,
  clientSecret: z
    .string()
    .trim()
    .regex(
      GOOGLE_OAUTH_CLIENT_SECRET,
      "paste the client secret exactly as the Google console shows it (it starts with GOCSPX-)",
    ),
});
export type RemoteMcpClientInput = z.infer<typeof remoteMcpClientInputSchema>;

export type RemoteMcpConfigureResult =
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
  readonly gatewayTimeoutMs?: number;
}

type Available = Extract<RemoteMcpAvailability, { status: "available" }>;

function secretFailure(e: unknown): RemoteMcpConfigureResult {
  const message = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    step: "secret",
    error: `the client could not be stored in Secret Manager: ${message}`,
    nextStep: /HTTP 403/.test(message)
      ? "The admin may not add versions to the remote-MCP secret yet. Run `cms-provision upgrade` (it grants that), then save again."
      : "Nothing was changed. Try again; if it keeps failing, report it with `bug_report`.",
  };
}

async function finish(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  clientId: string | null,
  deps: ConfigureDeps,
): Promise<RemoteMcpConfigureResult> {
  const sync = await (deps.sync ?? (() => syncOperatorAccess(registry, adapter, ctx)))();
  const checks = await runSelfCheck(deps.check ?? { fetch }, {
    mcpPublicUrl: available.mcpPublicUrl,
    clientId,
    sync,
    ...(deps.gatewayTimeoutMs !== undefined ? { gatewayTimeoutMs: deps.gatewayTimeoutMs } : {}),
  });
  return { ok: true, checks };
}

/** Store the Owner's OAuth client and turn remote MCP on, then self-check. */
export async function saveRemoteMcpClient(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  input: RemoteMcpClientInput,
  deps: ConfigureDeps = {},
): Promise<RemoteMcpConfigureResult> {
  try {
    await addSecretVersion(
      deps.google ?? defaultGoogleDeps(),
      available.secretResource,
      oauthClientFile(input),
    );
  } catch (e) {
    return secretFailure(e);
  }
  const set = await execute(registry, adapter, ctx, "mcp_remote_oauth.set", {
    clientId: input.clientId,
  });
  if (!set.ok) {
    return {
      ok: false,
      step: "database",
      error: `the client was stored for the gateway, but not recorded: ${JSON.stringify(set.error)}`,
      nextStep:
        "Save again (storing the same client twice is harmless). Until then Google IAP does not accept sign-ins from it.",
    };
  }
  return finish(registry, adapter, ctx, available, input.clientId, deps);
}

/** Turn remote MCP off: the gateway gets `{}`, IAP no programmatic client. */
export async function disableRemoteMcp(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  deps: ConfigureDeps = {},
): Promise<RemoteMcpConfigureResult> {
  try {
    await addSecretVersion(
      deps.google ?? defaultGoogleDeps(),
      available.secretResource,
      oauthClientFile(null),
    );
  } catch (e) {
    return secretFailure(e);
  }
  const cleared = await execute(registry, adapter, ctx, "mcp_remote_oauth.clear", {});
  if (!cleared.ok) {
    return {
      ok: false,
      step: "database",
      error: `the gateway stopped using the client, but it is still recorded: ${JSON.stringify(cleared.error)}`,
      nextStep: "Turn remote MCP off again; Google IAP keeps accepting the client until then.",
    };
  }
  return finish(registry, adapter, ctx, available, null, deps);
}

/** Re-run the sync and the self-check against what is configured now. */
export async function recheckRemoteMcp(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  available: Available,
  clientId: string | null,
  deps: ConfigureDeps = {},
): Promise<RemoteMcpConfigureResult> {
  return finish(registry, adapter, ctx, available, clientId, deps);
}
