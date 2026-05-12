// SPDX-License-Identifier: MPL-2.0

/**
 * Thin gcloud shell-out wrapper. The wizard composes high-level
 * "create the project + link billing + enable APIs + create SA +
 * grant roles + mint key" flows on top of these primitives.
 *
 * Why shell out instead of using the GCP SDK directly:
 *   - the user's gcloud auth state IS the auth (no separate
 *     credentials handling — `gcloud` already knows the user)
 *   - project create + billing link must happen as the user, NOT as
 *     a service account (the SA doesn't exist yet at bootstrap time)
 *   - error messages from gcloud are operator-readable; the SDK's
 *     gRPC errors aren't
 */

import { spawn } from "node:child_process";

export interface GcloudResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a gcloud command. Buffered stdout + stderr (max 4 MB each).
 * Throws on spawn failure but NOT on non-zero exit — caller checks `ok`.
 */
export async function gcloud(args: string[], opts: { stdin?: string } = {}): Promise<GcloudResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("gcloud", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (e) => reject(e));
    child.on("close", (code) =>
      resolveResult({
        ok: code === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      }),
    );
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Active gcloud account. Returns `null` when no account is logged in
 * — caller prompts `gcloud auth login`.
 */
export async function activeAccount(): Promise<string | null> {
  const r = await gcloud(["auth", "list", "--format=value(account)", "--filter=status:ACTIVE"]);
  if (!r.ok) return null;
  const value = r.stdout.trim();
  return value.length > 0 ? value : null;
}

export interface BillingAccount {
  id: string;
  displayName: string;
  open: boolean;
}

export async function listBillingAccounts(): Promise<BillingAccount[]> {
  const r = await gcloud(["billing", "accounts", "list", "--format=json"]);
  if (!r.ok) return [];
  try {
    const rows = JSON.parse(r.stdout) as Array<{
      name: string;
      displayName: string;
      open: boolean;
    }>;
    return rows.map((row) => ({
      id: row.name.replace(/^billingAccounts\//, ""),
      displayName: row.displayName,
      open: row.open,
    }));
  } catch {
    return [];
  }
}

export async function projectExists(projectId: string): Promise<boolean> {
  const r = await gcloud(["projects", "describe", projectId, "--format=value(projectId)"]);
  return r.ok && r.stdout.trim() === projectId;
}

export async function createProject(projectId: string, displayName: string): Promise<GcloudResult> {
  return gcloud(["projects", "create", projectId, "--name", displayName]);
}

export async function linkBilling(
  projectId: string,
  billingAccountId: string,
): Promise<GcloudResult> {
  return gcloud(["billing", "projects", "link", projectId, "--billing-account", billingAccountId]);
}

const REQUIRED_APIS: readonly string[] = [
  "compute.googleapis.com",
  "sqladmin.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "servicenetworking.googleapis.com",
  "dns.googleapis.com",
  "storage.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "iam.googleapis.com",
  "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com",
  "bigquery.googleapis.com",
  "iap.googleapis.com",
  // Used by gcp.projects.ServiceIdentity to provision the IAP-managed
  // service account that forwards authenticated requests to Cloud Run.
  "serviceusage.googleapis.com",
];

// v0.3.1 — gcp-firebase provider needs the Firebase Management +
// Firebase Hosting APIs on top of the gcp baseline. Without these
// the Pulumi `gcp.firebase.HostingSite` resource fails to create.
const GCP_FIREBASE_EXTRA_APIS: readonly string[] = [
  "firebase.googleapis.com",
  "firebasehosting.googleapis.com",
];

export async function enableApis(
  projectId: string,
  provider: "gcp" | "gcp-firebase" = "gcp",
): Promise<GcloudResult> {
  const apis =
    provider === "gcp-firebase" ? [...REQUIRED_APIS, ...GCP_FIREBASE_EXTRA_APIS] : REQUIRED_APIS;
  return gcloud(["services", "enable", ...apis, "--project", projectId]);
}

export async function serviceAccountExists(projectId: string, saEmail: string): Promise<boolean> {
  const r = await gcloud([
    "iam",
    "service-accounts",
    "describe",
    saEmail,
    "--project",
    projectId,
    "--format=value(email)",
  ]);
  return r.ok && r.stdout.trim() === saEmail;
}

export async function createServiceAccount(
  projectId: string,
  accountId: string,
  displayName: string,
): Promise<GcloudResult> {
  return gcloud([
    "iam",
    "service-accounts",
    "create",
    accountId,
    "--display-name",
    displayName,
    "--project",
    projectId,
  ]);
}

const PROVISIONER_ROLES: readonly string[] = [
  "roles/run.admin",
  "roles/cloudsql.admin",
  "roles/storage.admin",
  "roles/secretmanager.admin",
  "roles/iam.serviceAccountUser",
  "roles/compute.networkAdmin",
  "roles/dns.admin",
  "roles/servicenetworking.networksAdmin",
  "roles/iam.serviceAccountTokenCreator",
  "roles/cloudbuild.builds.editor",
  "roles/artifactregistry.admin",
  "roles/compute.securityAdmin",
  "roles/iam.serviceAccountAdmin",
  "roles/bigquery.admin",
  "roles/iap.admin",
  // compute.admin includes RegionNetworkEndpointGroups + URL maps +
  // BackendService variants the LB needs. compute.networkAdmin alone
  // doesn't cover NEG create.
  "roles/compute.admin",
  // logging.configWriter creates ProjectSink (BigQuery edge logs).
  "roles/logging.configWriter",
  // serviceusage.serviceUsageAdmin lets us trigger the IAP managed
  // service identity (gcp.projects.ServiceIdentity).
  "roles/serviceusage.serviceUsageAdmin",
  // v0.3.6 — Firebase Hosting + Firebase project administration
  // for the gcp-firebase provider variant. The stack's
  // `gcp.firebase.Project` (which adds Firebase services to a GCP
  // project) + `gcp.firebase.HostingSite` need these roles.
  // Granting on gcp installs is a harmless no-op since those
  // resources aren't created on that stack.
  "roles/firebase.admin",
  "roles/firebasehosting.admin",
  // v0.3.7 — project-level IAM binding admin. Required so the
  // provisioner SA can grant other SAs roles AT THE PROJECT LEVEL
  // via `gcp.projects.IAMMember`. The gcp-firebase stack uses
  // this for `roles/firebasehosting.admin` on the run SA so it
  // can deploy to Firebase Hosting. Without this role the
  // provisioner gets a 403 "Policy update access denied" when
  // creating project-level IAM bindings. Secret/bucket/SA-level
  // bindings already work via the per-resource admin roles above.
  "roles/resourcemanager.projectIamAdmin",
];

/**
 * Bind every role the GCP stack provisioner SA needs. Idempotent —
 * gcloud silently no-ops a binding that already exists.
 */
export async function grantProvisionerRoles(
  projectId: string,
  saEmail: string,
): Promise<{ granted: number; failed: string[] }> {
  let granted = 0;
  const failed: string[] = [];
  for (const role of PROVISIONER_ROLES) {
    const r = await gcloud([
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${saEmail}`,
      "--role",
      role,
      "--condition=None",
      "--quiet",
    ]);
    if (r.ok) granted++;
    else failed.push(role);
  }
  return { granted, failed };
}

export async function createServiceAccountKey(
  saEmail: string,
  outputPath: string,
): Promise<GcloudResult> {
  return gcloud([
    "iam",
    "service-accounts",
    "keys",
    "create",
    outputPath,
    "--iam-account",
    saEmail,
  ]);
}

export const REQUIRED_API_LIST = REQUIRED_APIS;
export const GCP_FIREBASE_EXTRA_API_LIST = GCP_FIREBASE_EXTRA_APIS;
export const PROVISIONER_ROLE_LIST = PROVISIONER_ROLES;

// v0.3.12 — removed createFirebaseHostingIdentity. The Service
// Usage GenerateServiceIdentity API doesn't support
// `firebasehosting.googleapis.com`, and `gcloud beta services
// identity create` would have returned the same error after a
// 2-min beta-component download. The SA gets auto-created lazily
// by Firebase Hosting on first deploy. We grant run.invoker at
// the project level instead of service level so the binding
// doesn't require the SA to exist at bind time.
