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
 *      IAP) — everything else on those two roles is removed and logged;
 *   3. exits non-zero when anything failed, so the execution shows as failed
 *      to the admin (gcp-job-trigger.ts) and in Cloud Run.
 *
 * Its whole input is the database and the env the provisioner set on the
 * job: the admin may start it but holds no `run.jobs.runWithOverrides`, so
 * it cannot pass arguments or env of its own.
 */

import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "../../audit.js";
import { operatorAccessMembersOp } from "../../ops/user_access.js";
import { defaultGoogleDeps, type GoogleDeps, reconcileResourceRole } from "./google-iam.js";
import { desiredMembers, parseStaticMembers, type Reconciled } from "./iam-policy.js";

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
}

/** Read the job's config from its env; throws naming every missing variable. */
export function configFromEnv(env: Record<string, string | undefined>): SyncJobConfig {
  const required = {
    iapWebPath: "CAELO_OPERATOR_ACCESS_IAP_WEB",
    mcpServiceAccount: "CAELO_MCP_IAP_SERVICE_ACCOUNT",
    staticMembers: "CAELO_OPERATOR_ACCESS_STATIC_MEMBERS",
    databaseHost: "CAELO_OPERATOR_ACCESS_DB_HOST",
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
  readonly log: (entry: LogEntry) => void;
}

export interface SyncReport {
  readonly ok: boolean;
  readonly iap?: Reconciled;
  readonly mcp?: Reconciled;
}

/** One reconcile pass over both managed bindings. Never throws. */
export async function runSync(config: SyncJobConfig, deps: SyncDeps): Promise<SyncReport> {
  let ok = true;
  const { members: staticMembers, rejected } = parseStaticMembers(config.staticMembers);
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
  ): Promise<Reconciled | undefined> => {
    try {
      const r = await reconcileResourceRole(deps.google, resourceUrl, role, desired, read);
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
  const iap = await apply(
    "the admin's IAP resource",
    `https://iap.googleapis.com/v1/projects/${projectNumber}/iap_web/${config.iapWebPath}`,
    IAP_ACCESSOR_ROLE,
    new Set([...members, `serviceAccount:${config.mcpServiceAccount}`]),
    { body: { options: { requestedPolicyVersion: 3 } } },
  );
  const mcp = await apply(
    `the MCP service account ${config.mcpServiceAccount}`,
    `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.mcpServiceAccount)}`,
    TOKEN_CREATOR_ROLE,
    members,
    { query: "?options.requestedPolicyVersion=3" },
  );
  return {
    ok: ok && iap !== undefined && mcp !== undefined,
    ...(iap ? { iap } : {}),
    ...(mcp ? { mcp } : {}),
  };
}

/**
 * Password-less database URLs for Cloud SQL IAM database authentication:
 * the user is the service account email without `.gserviceaccount.com`, the
 * password a short-lived OAuth token.
 */
export function iamDatabaseUrls(
  host: string,
  serviceAccountEmail: string,
  accessToken: string,
): { admin: string; public: string; user: string } {
  const user = serviceAccountEmail.replace(/\.gserviceaccount\.com$/, "");
  const url = (db: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(accessToken)}@${host}:5432/${db}?sslmode=require`;
  return { admin: url("cms_admin"), public: url("cms_public"), user };
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
  const readEmails = async (): Promise<string[]> => {
    const email = await google.metadata("instance/service-accounts/default/email");
    const urls = iamDatabaseUrls(config.databaseHost, email, await google.accessToken());
    adapter = new DatabaseAdapter({
      adminDatabaseUrl: urls.admin,
      publicDatabaseUrl: urls.public,
      expectedRoles: { admin: urls.user, public: [urls.user] },
    });
    const registry = new OperationRegistry();
    registry.register(operatorAccessMembersOp);
    const r = await execute(
      registry,
      adapter,
      {
        actorId: SYSTEM_ACTOR_ID,
        actorKind: "system",
        requestId: `operator-access-sync-${Date.now()}`,
      },
      "users.operator_access_members",
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { emails: string[] }).emails;
  };
  try {
    const report = await runSync(config, { google, readEmails, log });
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
