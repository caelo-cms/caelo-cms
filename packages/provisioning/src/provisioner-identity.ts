// SPDX-License-Identifier: MPL-2.0

/**
 * The keyless provisioner identity (#696, CLAUDE.md §11.C: "No long-lived
 * service-account keys downloaded to disk on user machines").
 *
 * Every GCP install has a `caelo-provisioner` service account holding the
 * roles Pulumi needs to converge the stack (gcloud.ts PROVISIONER_ROLES).
 * Installers before #696 minted a JSON key for it into
 * `~/.caelo-<id>/secrets/sa-key.json` and handed Pulumi that file. Now nobody
 * holds a key: the operator's own Google login impersonates the account.
 *
 *   - The operator's gcloud account gets `roles/iam.serviceAccountTokenCreator`
 *     on `caelo-provisioner` only (never project-wide), so it can mint
 *     short-lived tokens for that one account and nothing else
 *     ({@link ensureProvisionerImpersonation}).
 *   - Pulumi's GCP provider runs with `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`
 *     (wizards/gcp-pulumi.ts `pulumiGcpEnv`). Its source credential is the
 *     operator's Application Default Credentials, which refresh themselves,
 *     and the provider re-mints the impersonated token as it expires — so a
 *     `pulumi up` longer than an hour does not fail on an expired token, as a
 *     static `GOOGLE_OAUTH_ACCESS_TOKEN` would.
 *     adc-impersonation.ts verifies that chain before Pulumi starts.
 *   - An existing install's key is deleted, locally and in IAM, on its next
 *     `upgrade` or installer run ({@link removeLegacyProvisionerKey}). Only the
 *     IAM key whose id matches the local file is deleted; other user-managed
 *     keys of the account are reported, never deleted blindly.
 *
 * Nothing here handles a token or private key material: the key file is
 * read only for its id and account, and the file is then deleted.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";

/** Account id of the service account Pulumi converges the stack as. */
export const PROVISIONER_ACCOUNT_ID = "caelo-provisioner";

/** The role that lets the operator impersonate the provisioner. */
export const TOKEN_CREATOR_ROLE = "roles/iam.serviceAccountTokenCreator";

/** File name of the JSON key installers before #696 kept in `secrets/`. */
export const LEGACY_SA_KEY_FILE = "sa-key.json";

/**
 * Environment variables that would make Google's client libraries use a
 * credential other than the operator's Application Default Credentials —
 * a key file (perhaps the deleted `sa-key.json`), a static token that expires
 * after an hour, or another impersonation target. Removed from every
 * infrastructure run so the chain is always ADC → impersonated provisioner.
 */
export const AMBIENT_GOOGLE_CREDENTIAL_ENV: readonly string[] = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GCLOUD_KEYFILE_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
];

/** `caelo-provisioner@<project>.iam.gserviceaccount.com`. */
export function provisionerServiceAccountEmail(projectId: string): string {
  return `${PROVISIONER_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

/** `base` without the credential variables {@link AMBIENT_GOOGLE_CREDENTIAL_ENV} lists. */
export function withoutAmbientGoogleCredentials(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !AMBIENT_GOOGLE_CREDENTIAL_ENV.includes(k)) out[k] = v;
  }
  return out;
}

/** IAM member for a gcloud account: a service account when it is one, else a user. */
export function operatorMember(account: string): string {
  const email = account.trim().toLowerCase();
  return email.endsWith(".gserviceaccount.com") ? `serviceAccount:${email}` : `user:${email}`;
}

interface IamPolicy {
  bindings?: { role?: string; members?: string[] }[];
}

export type ImpersonationGrant =
  | { readonly ok: true; readonly status: "already" | "granted" }
  | { readonly ok: false; readonly error: string };

/**
 * Give the operator's gcloud account `roles/iam.serviceAccountTokenCreator`
 * on the provisioner service account (and on nothing else). Reads the
 * account's IAM policy first, so an operator who was granted the role by
 * someone else needs no IAM-write permission. Never throws for a gcloud
 * failure.
 */
export async function ensureProvisionerImpersonation(
  target: { readonly projectId: string; readonly operatorAccount: string },
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<ImpersonationGrant> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const sa = provisionerServiceAccountEmail(target.projectId);
  const member = operatorMember(target.operatorAccount);
  const project = `--project=${target.projectId}`;

  const policy = await runWithRetry(run, sleep, [
    "iam",
    "service-accounts",
    "get-iam-policy",
    sa,
    project,
    "--format=json",
  ]);
  if (policy.ok) {
    let parsed: IamPolicy = {};
    try {
      parsed = JSON.parse(policy.stdout || "{}") as IamPolicy;
    } catch {
      parsed = {};
    }
    const has = (parsed.bindings ?? []).some(
      (b) =>
        b.role === TOKEN_CREATOR_ROLE && (b.members ?? []).some((m) => m.toLowerCase() === member),
    );
    if (has) return { ok: true, status: "already" };
  }

  const grant = await runWithRetry(run, sleep, [
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    sa,
    project,
    `--member=${member}`,
    `--role=${TOKEN_CREATOR_ROLE}`,
    "--condition=None",
    "--quiet",
  ]);
  if (grant.ok) return { ok: true, status: "granted" };
  return { ok: false, error: grantError(target.projectId, sa, member, grant.stderr) };
}

function grantError(projectId: string, sa: string, member: string, stderr: string): string {
  const denied = /PERMISSION_DENIED|permission|403|not authorized/i.test(stderr);
  return [
    `Could not let ${member.replace(/^\w+:/, "")} impersonate ${sa}: ${stderr.trim() || "(no output)"}`,
    denied
      ? "Your gcloud account may not change that service account's IAM policy (it needs iam.serviceAccounts.setIamPolicy, e.g. roles/iam.serviceAccountAdmin or Owner on the project)."
      : "",
    "Ask a project Owner to run this once, then re-run:",
    `  gcloud iam service-accounts add-iam-policy-binding ${sa} --project=${projectId} --member=${member} --role=${TOKEN_CREATOR_ROLE} --condition=None`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type LegacyKeyReport =
  | {
      readonly ok: true;
      /** `none`: no local key file. `removed`: file (and its IAM key, if live) deleted. */
      readonly status: "none" | "removed";
      /** The IAM key id deleted, when the key was still live in IAM. */
      readonly deletedKeyId?: string;
      /** Lines for the operator: what was removed, other keys found. */
      readonly lines: string[];
    }
  | { readonly ok: false; readonly error: string };

interface ServiceAccountKeyRow {
  name?: string;
  keyType?: string;
}

/**
 * Delete the provisioner's JSON key an installer before #696 minted: first
 * the IAM key whose id matches the local file's `private_key_id`, then the
 * file. The file is only removed once its key is gone from IAM, so a failed
 * IAM delete can be retried on the next run. Other user-managed keys of the
 * account are listed in `lines` with the command to delete them — never
 * deleted here. Idempotent: no local file means nothing to do. Never throws
 * for a gcloud failure.
 */
export async function removeLegacyProvisionerKey(
  target: { readonly projectId: string; readonly secretsDir: string },
  deps: { run?: GcloudRunner } = {},
): Promise<LegacyKeyReport> {
  const run = deps.run ?? defaultGcloud;
  const sa = provisionerServiceAccountEmail(target.projectId);
  const project = `--project=${target.projectId}`;
  const keyPath = join(target.secretsDir, LEGACY_SA_KEY_FILE);
  if (!existsSync(keyPath)) return { ok: true, status: "none", lines: [] };

  const key = readKeyIdentity(keyPath);
  if (!key.ok) return { ok: false, error: key.error };
  if (key.clientEmail !== sa) {
    return {
      ok: false,
      error: `${keyPath} is a key for ${key.clientEmail}, not for ${sa}. It was left in place: check where it came from, delete it yourself, then re-run.`,
    };
  }

  const list = await run([
    "iam",
    "service-accounts",
    "keys",
    "list",
    `--iam-account=${sa}`,
    project,
    "--managed-by=user",
    "--format=json",
  ]);
  if (!list.ok) {
    return {
      ok: false,
      error: `Could not list the keys of ${sa}: ${list.stderr.trim()}\nYour gcloud account needs iam.serviceAccountKeys.list (e.g. roles/iam.serviceAccountKeyAdmin). ${keyPath} was left in place; re-run once fixed.`,
    };
  }
  let ids: string[];
  try {
    ids = (JSON.parse(list.stdout || "[]") as ServiceAccountKeyRow[])
      .filter((k) => k.keyType === undefined || k.keyType === "USER_MANAGED")
      .map((k) => (k.name ?? "").split("/").pop() ?? "")
      .filter((id) => id.length > 0);
  } catch {
    return { ok: false, error: `Could not read the key list of ${sa} (not JSON).` };
  }

  const lines: string[] = [];
  let deletedKeyId: string | undefined;
  if (ids.includes(key.keyId)) {
    const del = await run([
      "iam",
      "service-accounts",
      "keys",
      "delete",
      key.keyId,
      `--iam-account=${sa}`,
      project,
      "--quiet",
    ]);
    if (!del.ok) {
      return {
        ok: false,
        error: `Could not delete key ${key.keyId} of ${sa}: ${del.stderr.trim()}\nYour gcloud account needs iam.serviceAccountKeys.delete (e.g. roles/iam.serviceAccountKeyAdmin). ${keyPath} was left in place so the next run can match it; re-run once fixed.`,
      };
    }
    deletedKeyId = key.keyId;
    lines.push(`Deleted key ${key.keyId} of ${sa} in IAM.`);
  } else {
    lines.push(`Key ${key.keyId} of ${sa} was already deleted in IAM.`);
  }

  rmSync(keyPath, { force: true });
  lines.push(`Deleted ${keyPath}.`);

  const others = ids.filter((id) => id !== key.keyId);
  if (others.length > 0) {
    lines.push(
      `${sa} has ${others.length} other user-managed key(s) Caelo did not record, left in place: ${others.join(", ")}.`,
      "Caelo no longer uses keys for this account. If nothing else does, delete them with:",
      ...others.map(
        (id) => `  gcloud iam service-accounts keys delete ${id} --iam-account=${sa} ${project}`,
      ),
    );
  }
  return { ok: true, status: "removed", ...(deletedKeyId ? { deletedKeyId } : {}), lines };
}

/** The key id + account of a JSON key file, without keeping its private key. */
function readKeyIdentity(
  keyPath: string,
): { ok: true; keyId: string; clientEmail: string } | { ok: false; error: string } {
  let parsed: { private_key_id?: unknown; client_email?: unknown };
  try {
    parsed = JSON.parse(readFileSync(keyPath, "utf8")) as typeof parsed;
  } catch {
    return {
      ok: false,
      error: `${keyPath} is not a readable JSON key, so its IAM key can't be matched. Check the keys with \`gcloud iam service-accounts keys list --iam-account=<caelo-provisioner email> --managed-by=user\`, delete the one that file held, remove the file, then re-run.`,
    };
  }
  const keyId = typeof parsed.private_key_id === "string" ? parsed.private_key_id : "";
  const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
  if (!/^[0-9a-f]{40}$/i.test(keyId) || clientEmail === "") {
    return {
      ok: false,
      error: `${keyPath} has no service-account key id or account, so its IAM key can't be matched. Check the keys with \`gcloud iam service-accounts keys list --iam-account=<caelo-provisioner email> --managed-by=user\`, delete the one that file held, remove the file, then re-run.`,
    };
  }
  return { ok: true, keyId: keyId.toLowerCase(), clientEmail: clientEmail.toLowerCase() };
}

export type KeylessConvergence =
  | {
      readonly ok: true;
      /** `no-provisioner`: the project has no caelo-provisioner account; nothing to do. */
      readonly grant: "already" | "granted" | "no-provisioner";
      readonly legacyKey: "none" | "removed";
      readonly lines: string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Bring an install to the keyless provisioner (#696): the operator's gcloud
 * account may impersonate `caelo-provisioner`, and a key an older installer
 * minted is gone, locally and in IAM. The grant comes first, so a run that
 * cannot set it up stops before the key — today's only working credential
 * for older tooling — is deleted. Shared by the installer and `upgrade`;
 * idempotent; never throws for a gcloud failure.
 */
export async function convergeKeylessProvisioner(
  target: {
    readonly projectId: string;
    readonly secretsDir: string;
    readonly operatorAccount: string;
    /**
     * The installer just created the account: wait out IAM's propagation
     * delay instead of reading a NOT_FOUND as "no provisioner".
     */
    readonly justCreated?: boolean;
  },
  deps: { run?: GcloudRunner; sleep?: Sleep } = {},
): Promise<KeylessConvergence> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const sa = provisionerServiceAccountEmail(target.projectId);
  const keyOnDisk = existsSync(join(target.secretsDir, LEGACY_SA_KEY_FILE));
  const describeArgs = [
    "iam",
    "service-accounts",
    "describe",
    sa,
    `--project=${target.projectId}`,
    "--format=value(email)",
  ];
  const describe = target.justCreated
    ? await runWithRetry(run, sleep, describeArgs)
    : await run(describeArgs);
  if (!describe.ok && !/NOT_FOUND|does not exist|not found/i.test(describe.stderr)) {
    return { ok: false, error: `Could not read ${sa}: ${describe.stderr.trim()}` };
  }
  const exists = describe.ok && describe.stdout.trim().toLowerCase() === sa;
  if (!exists && !keyOnDisk) {
    return { ok: true, grant: "no-provisioner", legacyKey: "none", lines: [] };
  }
  if (!exists) {
    return {
      ok: false,
      error: `${join(target.secretsDir, LEGACY_SA_KEY_FILE)} holds a key for ${sa}, but that service account does not exist in ${target.projectId}. The key is unusable: delete the file, then re-run.`,
    };
  }

  const grant = await ensureProvisionerImpersonation(
    { projectId: target.projectId, operatorAccount: target.operatorAccount },
    deps,
  );
  if (!grant.ok) return grant;
  const legacy = await removeLegacyProvisionerKey(
    { projectId: target.projectId, secretsDir: target.secretsDir },
    { run },
  );
  if (!legacy.ok) return legacy;
  return { ok: true, grant: grant.status, legacyKey: legacy.status, lines: legacy.lines };
}
