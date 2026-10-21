// SPDX-License-Identifier: MPL-2.0

/**
 * The operator-access sync job — `bun --bun
 * /app/packages/admin-core/src/security/operator-access/sync-job.ts`, run as
 * a Cloud Run job from the admin image with its OWN service account
 * (packages/provisioning/src/operator-access.ts sets it up).
 *
 * It is the only principal allowed to change who passes the admin's Google
 * IAP gate and who may sign as `caelo-mcp`. Each run:
 *
 *   1. reads the emails that should have access (non-deleted users with a
 *      role) through `users.operator_access_members`, connecting with Cloud
 *      SQL IAM database authentication as a member of the read-only
 *      `operator_access_reader` role (no password, cannot write);
 *   2. makes `roles/iap.httpsResourceAccessor` on the admin's IAP resource
 *      and `roles/iam.serviceAccountTokenCreator` on `caelo-mcp` hold EXACTLY
 *      those `user:` members plus the static members the provisioner
 *      configured (the install's IAP allowlist, and `caelo-mcp` itself on
 *      IAP) — everything else on those two roles is removed and logged; a
 *      member Google has no account for is left out and logged as an error
 *      (google-iam.ts), so it cannot block the rest of the write;
 *   3. #914 — makes the PROJECT's IAP `oauthSettings` (browser sign-in
 *      client + its secret + `programmaticClients`) use EXACTLY the Google
 *      sign-in client the Owner configured (ID read through
 *      `operator_oauth.client_for_sync`, secret from Secret Manager), or
 *      none of them when none is, and keeps the admin's IAP resource free
 *      of a client of its own that would override the project's
 *      (iap-settings.ts says why the project level); a client it cannot
 *      read leaves the settings unchanged, never cleared;
 *   4. exits non-zero when anything failed, so the execution shows as failed
 *      to the admin (gcp-job-trigger.ts) and in Cloud Run.
 *
 * Its whole input is the database and the env the provisioner set on the
 * job: the admin may start it but holds no `run.jobs.runWithOverrides`, so
 * it cannot pass arguments or env of its own.
 */

import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { cloudSqlIamDatabaseUrls } from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../../audit.js";
import { operatorOAuthClientForSyncOp } from "../../ops/security/operator_oauth.js";
import { operatorAccessMembersOp } from "../../ops/user_access.js";
import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
  type ResourceReconciled,
  reconcileResourceRole,
} from "./google-iam.js";
import { desiredMembers, parseStaticMembers } from "./iam-policy.js";
import {
  type DesiredOAuthClient,
  iapProjectResourceUrl,
  type OAuthSettingsReconciled,
  reconcileOAuthSettings,
} from "./iap-settings.js";

export const IAP_ACCESSOR_ROLE = "roles/iap.httpsResourceAccessor";
export const TOKEN_CREATOR_ROLE = "roles/iam.serviceAccountTokenCreator";

export interface SyncJobConfig {
  /** `cloud_run-<region>/services/<svc>` (gcp-firebase) or `compute/services/<backend>` (gcp). */
  readonly iapWebPath: string;
  readonly mcpServiceAccount: string;
  /** Comma-separated; see iam-policy.ts parseStaticMembers. */
  readonly staticMembers: string;
  /** Cloud SQL private IP. */
  readonly databaseHost: string;
  /**
   * Comma-separated service accounts that keep token-creator on caelo-mcp
   * besides the users (the upgrader job, #696); empty on installs without one.
   */
  readonly mcpSigners: string;
  /**
   * #914 — `projects/<p>/secrets/<id>` of the Google sign-in client
   * (`caelo-<env>-operator-oauth-client`); the job may read only this secret.
   */
  readonly oauthClientSecret: string;
}

/** Read the job's config from its env; throws naming every missing variable. */
export function configFromEnv(env: Record<string, string | undefined>): SyncJobConfig {
  const required = {
    iapWebPath: "CAELO_OPERATOR_ACCESS_IAP_WEB",
    mcpServiceAccount: "CAELO_MCP_IAP_SERVICE_ACCOUNT",
    staticMembers: "CAELO_OPERATOR_ACCESS_STATIC_MEMBERS",
    databaseHost: "CAELO_OPERATOR_ACCESS_DB_HOST",
    oauthClientSecret: "CAELO_OPERATOR_OAUTH_CLIENT_SECRET",
  } as const;
  const missing = Object.values(required).filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `operator-access sync job: missing env ${missing.join(", ")} — the job is set up by \`cms-provision upgrade\`.`,
    );
  }
  const get = (name: string) => (env[name] ?? "").trim();
  return {
    iapWebPath: get(required.iapWebPath),
    mcpServiceAccount: get(required.mcpServiceAccount),
    staticMembers: get(required.staticMembers),
    databaseHost: get(required.databaseHost),
    oauthClientSecret: get(required.oauthClientSecret),
    // Optional: jobs set up before the upgrader existed do not carry it.
    mcpSigners: get("CAELO_OPERATOR_ACCESS_MCP_SIGNERS"),
  };
}

/** One Cloud Logging entry (structured JSON on stdout). */
export interface LogEntry {
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly [field: string]: unknown;
}

export interface SyncDeps {
  readonly google: GoogleDeps;
  readonly readEmails: () => Promise<string[]>;
  /** #914 — the configured Google sign-in client ID, null when none is set. */
  readonly readOAuthClientId: () => Promise<string | null>;
  /** #914 — the sign-in client as stored in Secret Manager (read only when an ID is set). */
  readonly readOAuthClientFile: () => Promise<OAuthClientFile>;
  readonly log: (entry: LogEntry) => void;
}

export interface SyncReport {
  readonly ok: boolean;
  readonly iap?: ResourceReconciled;
  readonly mcp?: ResourceReconciled;
  /** #914 — the project-level `oauthSettings` (the Google sign-in client). */
  readonly oauthSettings?: OAuthSettingsReconciled;
  /** #914 — the admin IAP resource's own `oauthSettings`, kept empty so the project's apply. */
  readonly resourceOAuthOverride?: OAuthSettingsReconciled;
}

/** One reconcile pass over both managed bindings. Never throws. */
export async function runSync(config: SyncJobConfig, deps: SyncDeps): Promise<SyncReport> {
  let ok = true;
  const { members: staticMembers, rejected: rejectedStatic } = parseStaticMembers(
    config.staticMembers,
  );
  const { members: mcpSigners, rejected: rejectedSigners } = parseStaticMembers(config.mcpSigners);
  const rejected = [...rejectedStatic, ...rejectedSigners];
  for (const entry of rejected) {
    ok = false;
    deps.log({
      severity: "ERROR",
      message: `static member "${entry}" ignored: only user:, group: and serviceAccount: principals are ever granted`,
    });
  }

  let emails: string[];
  try {
    emails = await deps.readEmails();
  } catch (e) {
    deps.log({
      severity: "ERROR",
      message: `could not read the user list: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false };
  }
  const { members, invalidEmails } = desiredMembers(emails, staticMembers);
  for (const email of invalidEmails) {
    deps.log({
      severity: "WARNING",
      message: `user email "${email}" is not a valid Google account address; not granted`,
    });
  }

  const apply = async (
    what: string,
    resourceUrl: string,
    role: string,
    desired: ReadonlySet<string>,
    read: { body?: unknown; query?: string },
  ): Promise<ResourceReconciled | undefined> => {
    try {
      const r = await reconcileResourceRole(deps.google, resourceUrl, role, desired, read);
      // Everyone else was still brought in line; the run reports failure so
      // the admin shows it, naming who cannot be granted.
      for (const member of r.unknownPrincipals) {
        ok = false;
        deps.log({
          severity: "ERROR",
          message: `could not grant ${role} to ${member} on ${what}: Google has no account with that address — the Caelo user cannot sign in. In /settings/users delete the user and create them again with the address of their Google account; every other member was updated`,
          member,
          role,
        });
      }
      for (const member of r.added) {
        deps.log({
          severity: "INFO",
          message: `granted ${role} to ${member} on ${what}`,
          member,
          role,
        });
      }
      for (const m of r.removed) {
        deps.log({
          severity: "WARNING",
          message: `REMOVED ${m.member} from ${role} on ${what}${m.condition ? " (conditional binding)" : ""} — not on the Caelo user list or the install's allowlist`,
          member: m.member,
          role,
          ...(m.condition ? { condition: m.condition } : {}),
        });
      }
      if (!r.next) deps.log({ severity: "INFO", message: `${role} on ${what} already up to date` });
      return r;
    } catch (e) {
      ok = false;
      deps.log({
        severity: "ERROR",
        message: `could not update ${role} on ${what}: ${e instanceof Error ? e.message : String(e)}`,
      });
      return undefined;
    }
  };

  let projectNumber: string;
  try {
    projectNumber = (await deps.google.metadata("project/numeric-project-id")).trim();
  } catch (e) {
    deps.log({
      severity: "ERROR",
      message: `metadata server: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false };
  }
  // IAP resource names use the project NUMBER
  // (cloud.google.com/iap/docs/managing-access#resources_and_permissions).
  const iapResourceUrl = `https://iap.googleapis.com/v1/projects/${projectNumber}/iap_web/${config.iapWebPath}`;
  const iap = await apply(
    "the admin's IAP resource",
    iapResourceUrl,
    IAP_ACCESSOR_ROLE,
    new Set([...members, `serviceAccount:${config.mcpServiceAccount}`]),
    { body: { options: { requestedPolicyVersion: 3 } } },
  );
  const mcp = await apply(
    `the MCP service account ${config.mcpServiceAccount}`,
    `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.mcpServiceAccount)}`,
    TOKEN_CREATOR_ROLE,
    new Set([...members, ...mcpSigners]),
    { query: "?options.requestedPolicyVersion=3" },
  );
  const oauthSettings = await syncOAuthSettings(deps, iapProjectResourceUrl(projectNumber));
  // Only once the project holds the right client: clearing the resource's
  // own client first could leave IAP on the wrong one in between.
  const resourceOAuthOverride = oauthSettings
    ? await clearResourceOAuthOverride(deps, iapResourceUrl)
    : undefined;
  return {
    ok:
      ok &&
      iap !== undefined &&
      mcp !== undefined &&
      oauthSettings !== undefined &&
      resourceOAuthOverride !== undefined,
    ...(iap ? { iap } : {}),
    ...(mcp ? { mcp } : {}),
    ...(oauthSettings ? { oauthSettings } : {}),
    ...(resourceOAuthOverride ? { resourceOAuthOverride } : {}),
  };
}

/**
 * The Google sign-in client as the Secret Manager secret holds it (contract
 * #806/#914): `{"client_id","client_secret"}`, `{}` while none is set.
 */
export interface OAuthClientFile {
  readonly client_id?: string;
  readonly client_secret?: string;
}

/**
 * #914 — the project's IAP `oauthSettings` := exactly the configured Google
 * sign-in client (browser client + secret + programmatic clients), or none
 * of them. Undefined (and logged) on any failure; a
 * client that cannot be read — the database row, or the secret behind it —
 * leaves the settings as they are: clearing them then would lock every
 * account outside the organisation out because of a hiccup.
 */
async function syncOAuthSettings(
  deps: SyncDeps,
  projectSettingsUrl: string,
): Promise<OAuthSettingsReconciled | undefined> {
  const what = "the project's IAP OAuth settings";
  const unchanged = (message: string): undefined => {
    deps.log({ severity: "ERROR", message: `${message}; ${what} left unchanged` });
    return undefined;
  };
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let clientId: string | null;
  try {
    clientId = await deps.readOAuthClientId();
  } catch (e) {
    return unchanged(`could not read the Google sign-in client: ${reason(e)}`);
  }
  let desired: DesiredOAuthClient = null;
  if (clientId) {
    let file: OAuthClientFile;
    try {
      file = await deps.readOAuthClientFile();
    } catch (e) {
      return unchanged(`could not read the Google sign-in client's secret: ${reason(e)}`);
    }
    if (file.client_id !== clientId || !file.client_secret) {
      return unchanged(
        `the Google sign-in client recorded in Caelo (${clientId}) is not the one stored in Secret Manager (${file.client_id ?? "none"}) — save the client again under Settings → Google sign-in`,
      );
    }
    desired = { clientId, clientSecret: file.client_secret };
  }
  let r: OAuthSettingsReconciled;
  try {
    r = await reconcileOAuthSettings(deps.google, projectSettingsUrl, desired);
  } catch (e) {
    deps.log({ severity: "ERROR", message: `could not update ${what}: ${reason(e)}` });
    return undefined;
  }
  if (!r.changed) {
    deps.log({ severity: "INFO", message: `${what} already up to date` });
    return r;
  }
  if (r.after.clientId && r.after.clientId !== r.before.clientId) {
    deps.log({
      severity: "INFO",
      message: `IAP now signs people in with the Google sign-in client ${r.after.clientId}; accounts outside the organisation can pass`,
      clientId: r.after.clientId,
    });
  }
  if (r.secretReason) {
    deps.log({
      severity: "INFO",
      message:
        r.secretReason === "differs"
          ? "IAP held another secret for the Google sign-in client; set the current one"
          : "IAP reported no hash of the client secret to compare against; set it again",
    });
  }
  if (r.before.clientId && r.before.clientId !== r.after.clientId) {
    deps.log({
      severity: "WARNING",
      message: `REMOVED OAuth client ${r.before.clientId} from IAP browser sign-in — not the Google sign-in client configured in Caelo${r.after.clientId ? "" : "; IAP uses its Google-managed client again, which admits only the organisation's accounts"}`,
      clientId: r.before.clientId,
    });
  }
  for (const id of r.before.programmaticClients) {
    if (r.after.programmaticClients.includes(id)) continue;
    deps.log({
      severity: "WARNING",
      message: `REMOVED OAuth client ${id} from the project's IAP programmatic clients — not the Google sign-in client configured in Caelo`,
      clientId: id,
    });
  }
  return r;
}

/**
 * #914 — the admin IAP resource must not carry `oauthSettings` of its own:
 * a client there would override the project's (the IAP settings hierarchy
 * lets the lower level win), so a client set by hand — or by a release that
 * still wrote the resource — would keep IAP on it, and removing Google
 * sign-in would not take effect. Clears client, secret and programmatic
 * clients there (keeping `loginHint`); a no-op GET when none are set.
 */
async function clearResourceOAuthOverride(
  deps: SyncDeps,
  iapResourceUrl: string,
): Promise<OAuthSettingsReconciled | undefined> {
  const what = "the OAuth settings of the admin's IAP resource";
  let r: OAuthSettingsReconciled;
  try {
    r = await reconcileOAuthSettings(deps.google, iapResourceUrl, null);
  } catch (e) {
    deps.log({
      severity: "ERROR",
      message: `could not clear ${what}: ${e instanceof Error ? e.message : String(e)}`,
    });
    return undefined;
  }
  if (!r.changed) return r;
  const ids = [
    ...new Set([
      ...(r.before.clientId ? [r.before.clientId] : []),
      ...r.before.programmaticClients,
    ]),
  ];
  for (const id of ids) {
    deps.log({
      severity: "WARNING",
      message: `REMOVED OAuth client ${id} from ${what} — the Google sign-in client is set for the whole project, and a client on the resource itself would override it`,
      clientId: id,
    });
  }
  return r;
}

/**
 * Read the Google sign-in client file from Secret Manager (`latest` of
 * `secretResource`, `projects/<p>/secrets/<id>`). The job's SA holds
 * `secretAccessor` on exactly that secret (provisioning operator-access.ts).
 */
export async function readOAuthClientSecret(
  google: GoogleDeps,
  secretResource: string,
): Promise<OAuthClientFile> {
  const res = (await googleCall(
    google,
    `https://secretmanager.googleapis.com/v1/${secretResource}/versions/latest:access`,
    "GET",
  )) as { payload?: { data?: string } };
  const data = res.payload?.data;
  if (!data) throw new Error(`${secretResource}: the latest version has no payload`);
  const parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${secretResource}: the latest version is not a JSON object`);
  }
  return parsed as OAuthClientFile;
}

async function main(): Promise<void> {
  const log = (entry: LogEntry) => console.log(JSON.stringify(entry));
  let config: SyncJobConfig;
  try {
    config = configFromEnv(process.env);
  } catch (e) {
    log({ severity: "ERROR", message: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
    return;
  }
  const google = defaultGoogleDeps();
  let adapter: DatabaseAdapter | undefined;
  const registry = new OperationRegistry();
  registry.register(operatorAccessMembersOp);
  registry.register(operatorOAuthClientForSyncOp);
  /** One read-only connection for both reads, opened on first use. */
  const read = async (op: string): Promise<unknown> => {
    if (!adapter) {
      const email = await google.metadata("instance/service-accounts/default/email");
      const urls = cloudSqlIamDatabaseUrls(config.databaseHost, email, await google.accessToken());
      adapter = new DatabaseAdapter({
        adminDatabaseUrl: urls.admin,
        publicDatabaseUrl: urls.public,
        expectedRoles: { admin: urls.user, public: [urls.user] },
      });
    }
    const r = await execute(
      registry,
      adapter,
      {
        actorId: SYSTEM_ACTOR_ID,
        actorKind: "system",
        requestId: `operator-access-sync-${Date.now()}`,
      },
      op,
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  const readEmails = async () =>
    ((await read("users.operator_access_members")) as { emails: string[] }).emails;
  const readOAuthClientId = async () =>
    ((await read("operator_oauth.client_for_sync")) as { clientId: string | null }).clientId;
  const readOAuthClientFile = () => readOAuthClientSecret(google, config.oauthClientSecret);
  try {
    const report = await runSync(config, {
      google,
      readEmails,
      readOAuthClientId,
      readOAuthClientFile,
      log,
    });
    log({
      severity: report.ok ? "INFO" : "ERROR",
      message: report.ok ? "operator access in sync" : "operator access sync finished with errors",
    });
    if (!report.ok) process.exitCode = 1;
  } finally {
    await adapter?.close();
  }
}

if (import.meta.main) await main();
